/**
 * dsh-plugin-photoshop — the Photoshop bridge.
 *
 * Photoshop has no local RPC of its own on Windows, but it does register a COM
 * automation server under the version-independent ProgID
 * `Photoshop.Application`. That server exposes a single useful entry point for
 * us — `DoJavaScript(code)`, which runs ExtendScript inside the running
 * Photoshop and hands its result back to the caller. So the bridge is:
 *
 *   Node → powershell.exe -File runner.ps1 → New-Object -ComObject → DoJavaScript
 *
 * Everything that crosses the boundary is carried by files written as UTF-8,
 * never by the console: Windows PowerShell encodes stdout in the console code
 * page, which mangles non-ASCII paths and messages.
 *
 *   <tmp>/script.jsx    the ExtendScript the recipe generated (UTF-8, read back by the runner)
 *   <tmp>/result.json   the recipe's own JSON result, written by ExtendScript
 *   <tmp>/progress.json optional per-item progress, written by ExtendScript
 *   <tmp>/cancel       a marker Node creates to ask a running batch to stop
 *   <tmp>/status.txt   the runner's own verdict (OK / PHOTOSHOP_UNAVAILABLE / SCRIPT_ERROR)
 *
 * Attaching to the COM server launches Photoshop when it is not already
 * running; `isPhotoshopRunning()` reports which case a call is about to face.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

/** Image formats Photoshop 2020+ can open directly, used for directory expansion. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.tif', '.tiff', '.bmp', '.psd', '.psb',
  '.gif', '.webp', '.heic', '.avif', '.tga', '.exr', '.dng', '.cr2', '.nef', '.arw',
])

/**
 * The PowerShell half. Kept to ASCII so it needs no BOM and no code page
 * negotiation; every real message is written through .NET as UTF-8 instead.
 *
 * It retries the COM calls on RPC_E_SERVERCALL_RETRYLATER. Photoshop answers
 * with that while it is busy — mid-filter, mid-action, with a dialog up, or
 * simply because the user is working in it — and it means "ask again shortly",
 * not "failed". Reporting it as a failure is how a plugin looks broken when the
 * user is merely using their own application.
 *
 * Note that a timeout only stops our side: Photoshop keeps running whatever it
 * was given. That is why the batch and cutout recipes poll a cancel marker
 * between items, and why the operation vocabulary is preferred over a long
 * action for anything that must be interruptible.
 */
const RUNNER_PS1 = `param(
  [Parameter(Mandatory = $true)][string]$JsxPath,
  [Parameter(Mandatory = $true)][string]$StatusPath,
  [int]$Retries = 20,
  [int]$RetryDelayMs = 2000
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Write-Status([string]$text) {
  [System.IO.File]::WriteAllText($StatusPath, $text, $utf8)
}

function Invoke-WithRetry {
  param([scriptblock]$Action)
  $attempt = 0
  while ($true) {
    try { return & $Action }
    catch {
      if ($_.Exception.Message -match '0x8001010A' -and $attempt -lt $Retries) {
        $attempt++
        Start-Sleep -Milliseconds $RetryDelayMs
        continue
      }
      throw
    }
  }
}

try {
  $app = Invoke-WithRetry { New-Object -ComObject Photoshop.Application }
} catch {
  Write-Status ('PHOTOSHOP_UNAVAILABLE: ' + $_.Exception.Message)
  exit 2
}
try {
  $code = [System.IO.File]::ReadAllText($JsxPath, [System.Text.Encoding]::UTF8)
  Invoke-WithRetry { [void]$app.DoJavaScript($code) } | Out-Null
  Write-Status 'OK'
} catch {
  if ($_.Exception.Message -match '0x8001010A') {
    Write-Status ('PHOTOSHOP_BUSY: ' + $_.Exception.Message)
  } else {
    Write-Status ('SCRIPT_ERROR: ' + $_.Exception.Message)
  }
  exit 1
} finally {
  try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
}
`

/** PowerShell hosts to try, in order. Windows PowerShell ships with every Windows. */
const POWERSHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe', 'pwsh']

/**
 * Whether Photoshop is currently running. Attaching to COM starts the app when
 * it is not, which is worth telling the caller about: a cold start can take a
 * minute or more, and the user sees a window appear.
 * @returns 'running' | 'stopped' | 'unknown'
 */
export function isPhotoshopRunning() {
  try {
    const probe = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    if (probe.error !== undefined || typeof probe.stdout !== 'string') return 'unknown'
    return /photoshop\.exe/i.test(probe.stdout) ? 'running' : 'stopped'
  } catch {
    return 'unknown'
  }
}

/**
 * Expand the caller's paths into a concrete, ordered list of image files.
 * A directory is read one level deep, or recursively when asked.
 * @param paths - files and/or directories, absolute or relative.
 * @param recursive - whether directories are walked to any depth.
 * @param cwd - base directory for relative paths.
 * @returns the resolved image file paths, plus any paths that matched nothing.
 */
export function collectImages(paths, recursive = false, cwd = process.cwd()) {
  const files = []
  const missing = []
  const seen = new Set()
  const push = (file) => {
    const key = file.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    files.push(file)
  }
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive) walk(full)
      } else if (IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        push(full)
      }
    }
  }
  for (const input of paths ?? []) {
    if (typeof input !== 'string' || input.trim() === '') continue
    const absolute = resolve(cwd, input.trim())
    if (!existsSync(absolute)) {
      missing.push(input)
      continue
    }
    if (IMAGE_EXTENSIONS.has(extname(absolute).toLowerCase())) push(absolute)
    else walk(absolute)
  }
  return { files, missing }
}

/**
 * Allocate one bridge session: a temp directory holding every file of one
 * Photoshop round trip, plus the paths the generated ExtendScript must write to.
 * @returns the session handle.
 */
export function createSession() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-photoshop-'))
  const session = {
    dir,
    resultPath: join(dir, 'result.json'),
    progressPath: join(dir, 'progress.json'),
    cancelPath: join(dir, 'cancel.marker'),
    statusPath: join(dir, 'status.txt'),
    /** Create the marker a running batch polls between items to stop early. */
    requestCancel() {
      try {
        writeFileSync(session.cancelPath, 'cancel', 'utf8')
      } catch {
        /* the kill fallback still applies */
      }
    },
    /**
     * Run one generated ExtendScript through Photoshop.
     * @param jsxSource - the complete script source.
     * @param options - timeout, abort signal, and whether the script polls the cancel marker.
     * @returns how the round trip ended; the script's own JSON is read from resultPath.
     */
    run(jsxSource, options = {}) {
      const { timeoutMs = 900000, signal, gracefulCancel = false } = options
      const jsxPath = join(dir, 'script.jsx')
      const runnerPath = join(dir, 'runner.ps1')
      writeFileSync(jsxPath, jsxSource, 'utf8')
      writeFileSync(runnerPath, RUNNER_PS1, 'utf8')

      return new Promise((resolveRun) => {
        let settled = false
        let timedOut = false
        let aborted = false
        let killTimer = null
        let timeoutTimer = null
        let child = null
        let hostIndex = 0

        const finish = (outcome) => {
          if (settled) return
          settled = true
          if (timeoutTimer !== null) clearTimeout(timeoutTimer)
          if (killTimer !== null) clearTimeout(killTimer)
          if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
          resolveRun(outcome)
        }

        const readStatus = () => {
          try {
            return readFileSync(session.statusPath, 'utf8').trim()
          } catch {
            return ''
          }
        }

        const hardStop = () => {
          if (child !== null && child.exitCode === null) {
            try {
              child.kill()
            } catch {
              /* already gone */
            }
          }
        }

        const softStop = (reason) => {
          if (reason === 'timeout') timedOut = true
          else aborted = true
          if (gracefulCancel) {
            // The script polls the marker between items, so the current image
            // still finishes cleanly and Photoshop is left in a known state.
            session.requestCancel()
            killTimer = setTimeout(hardStop, 10000)
          } else {
            hardStop()
          }
        }

        function onAbort() {
          softStop('abort')
        }

        const start = () => {
          const exe = POWERSHELL_CANDIDATES[hostIndex]
          child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath, jsxPath, session.statusPath], {
            windowsHide: true,
            stdio: 'ignore',
          })
          child.on('error', (error) => {
            // A missing PowerShell host is a probe result, not a failure yet.
            if (error?.code === 'ENOENT' && hostIndex < POWERSHELL_CANDIDATES.length - 1) {
              hostIndex += 1
              start()
              return
            }
            finish({ ok: false, timedOut, aborted, status: `RUNNER_UNAVAILABLE: ${error?.message ?? String(error)}`, host: exe })
          })
          child.on('close', (code) => {
            if (timedOut || aborted) {
              finish({ ok: false, timedOut, aborted, status: readStatus() || (timedOut ? 'TIMED_OUT' : 'ABORTED'), host: exe })
              return
            }
            const status = readStatus()
            finish({ ok: code === 0 && status === 'OK', timedOut, aborted, status: status || `EXIT_${code}`, host: exe })
          })
        }

        if (signal?.aborted === true) {
          finish({ ok: false, timedOut: false, aborted: true, status: 'ABORTED', host: '' })
          return
        }
        signal?.addEventListener?.('abort', onAbort)
        timeoutTimer = setTimeout(() => softStop('timeout'), timeoutMs)
        start()
      })
    },
    /** Remove the whole session directory. Safe to call more than once. */
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* a leftover temp directory is harmless */
      }
    },
  }
  return session
}

/**
 * Read the JSON a recipe wrote, tolerating the BOM ExtendScript adds.
 * @param path - the file the recipe wrote.
 * @returns the parsed value, or undefined when absent or unparseable.
 */
export function readJsonFile(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Turn one bridge outcome plus the recipe's JSON into a single sentence a model
 * can act on, naming the most likely cause rather than echoing a stack.
 * @param outcome - the result of `session.run`.
 * @param result - the recipe's parsed JSON, when it produced one.
 * @returns a diagnostic string, or '' when the call succeeded.
 */
export function describeFailure(outcome, result) {
  if (outcome.ok && result !== undefined && result.ok !== false) return ''
  if (outcome.aborted) return 'Photoshop call was cancelled.'
  if (outcome.timedOut) {
    return `Photoshop did not answer within the time budget (${outcome.status || 'no status'}). Large batches need a bigger timeoutMs; a cold Photoshop start can also take a minute.`
  }
  if (outcome.status.startsWith('PHOTOSHOP_BUSY')) {
    return 'Photoshop is busy and refused the call for two minutes. Look at the Photoshop window: a modal dialog is the usual cause — an action that prompts, or an alert waiting for a click — and it blocks the very channel that would dismiss it, so a human has to clear it. If a timeout killed an earlier call, Photoshop may also still be running that script; it finishes on its own, but any dialog it raises needs dismissing. The plugin retries for two minutes before giving up.'
  }
  if (outcome.status.startsWith('PHOTOSHOP_UNAVAILABLE')) {
    return `Adobe Photoshop is not reachable through COM automation (${outcome.status}). Check that Photoshop is installed on this Windows machine.`
  }
  if (outcome.status.startsWith('RUNNER_UNAVAILABLE')) {
    return `No PowerShell host could be started (${outcome.status}).`
  }
  if (outcome.status.startsWith('SCRIPT_ERROR')) {
    return `Photoshop refused the script: ${outcome.status.replace(/^SCRIPT_ERROR:\s*/, '')}`
  }
  if (result !== undefined && typeof result.error === 'string') return `Photoshop reported: ${result.error}`
  return `Photoshop call failed (${outcome.status || 'no status'}).`
}

export { IMAGE_EXTENSIONS }
