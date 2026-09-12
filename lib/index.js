/**
 * dsh-plugin-photoshop — the Cordis plugin.
 *
 * Registers three model-facing tools that give an agent the local Adobe
 * Photoshop installation as a capability:
 *
 *   photoshop_status    what is installed, what is open, what is scriptable
 *   photoshop_inspect   what is on screen: documents, selection, layer tree
 *   photoshop_cutout    batch Select Subject / Remove Background to alpha PNGs
 *   photoshop_apply     run a plan of named operations against open documents
 *   photoshop_reference the operation vocabulary, on demand
 *   photoshop_run_jsx   run arbitrary ExtendScript (the escape hatch)
 *
 * The plugin is deliberately host-only and dependency-free: it imports nothing
 * outside Node's standard library, so it cannot fail to load because a
 * framework package resolved differently in someone else's profile. It reads
 * services with `ctx.get` and contributes a prompt section only when the
 * system-prompt registry is present.
 *
 * Environment overrides:
 *   DSH_PHOTOSHOP_TIMEOUT_MS   default per-call budget (default 900000)
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { cutoutScript, inspectScript, rawScript, statusScript } from './jsx.js'
import { applyScript } from './ops-jsx.js'
import { readPngInfo } from './png.js'
import { formatApplyReport, formatInspectReport } from './report.js'
import { collectImages, createSession, describeFailure, isPhotoshopRunning, readJsonFile } from './ps.js'
import { defineTool } from './tool.js'
import { OPERATION_NAME_SET, VOCABULARY, formatReference, suggestOperations } from './vocabulary.js'

export const name = 'tool-photoshop'

/** `tools` is required; the prompt registry is optional and read with `ctx.get`. */
export const inject = ['tools']

/** Ordered by the same convention the shipped tool plugins use. */
const PROMPT_SECTION_ORDER = 120

/** Guard rail: a batch bigger than this is almost certainly a mistaken path. */
const MAX_BATCH_FILES = 2000

/** How many per-file lines a report spells out before summarising the rest. */
const REPORT_ITEM_LIMIT = 40

/** How many layers an inspection reports before it stops descending. */
const MAX_INSPECTED_LAYERS = 400

/** Default cooperative budget for one Photoshop round trip. */
function defaultTimeoutMs() {
  const configured = Number(process.env.DSH_PHOTOSHOP_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 900000
}

/** Photoshop's scripting API wants forward slashes in file paths. */
function toPosix(path) {
  return path.replace(/\\/g, '/')
}

/**
 * Pair every input image with the PNG it should produce, refusing to clobber
 * existing files unless asked and disambiguating same-named inputs from
 * different directories.
 * @param files - resolved input image paths.
 * @param outputDir - absolute output directory.
 * @param suffix - text inserted before the extension.
 * @param overwrite - whether an existing output may be replaced.
 * @returns the work list plus the entries that were skipped.
 */
function planOutputs(files, outputDir, suffix, overwrite) {
  const taken = new Set()
  const pairs = []
  const skipped = []
  for (const input of files) {
    const stem = basename(input, extname(input)) + suffix
    let candidate = join(outputDir, `${stem}.png`)
    if (existsSync(candidate) && !overwrite) {
      skipped.push({ input, output: candidate, reason: 'output already exists (pass overwrite: true to replace)' })
      continue
    }
    let counter = 2
    while (taken.has(candidate.toLowerCase()) || (existsSync(candidate) && !overwrite)) {
      candidate = join(outputDir, `${stem}-${counter}.png`)
      counter += 1
      if (counter > 9999) break
    }
    taken.add(candidate.toLowerCase())
    pairs.push({ input: toPosix(input), output: toPosix(candidate) })
  }
  return { pairs, skipped }
}

/**
 * Check a plan before Photoshop is involved, so a typo costs a sentence instead
 * of an aborted round trip.
 * @param plan - the operations the caller sent.
 * @returns an explanation, or '' when the plan is well formed.
 */
function validatePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) {
    return 'Pass a non-empty `ops` array. Call photoshop_reference to see the available operations.'
  }
  for (let index = 0; index < plan.length; index += 1) {
    const op = plan[index]
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      return `Operation ${index + 1} is not an object.`
    }
    if (typeof op.op !== 'string' || op.op === '') {
      return `Operation ${index + 1} has no "op" field naming the operation.`
    }
    if (!OPERATION_NAME_SET.has(op.op)) {
      const suggestions = suggestOperations(op.op)
      const hint = suggestions.length > 0 ? ` Did you mean ${suggestions.join(', ')}?` : ''
      return `Unknown operation "${op.op}" (operation ${index + 1}).${hint} Call photoshop_reference for the full list.`
    }
  }
  return ''
}

/** Run one Photoshop round trip and hand back both the parsed recipe result and
 * the failure sentence, if any.
 * @param session - the bridge session.
 * @param jsx - generated ExtendScript.
 * @param options - timeout and abort signal.
 * @returns the recipe result and how the round trip ended.
 */
async function roundTrip(session, jsx, options) {
  const outcome = await session.run(jsx, options)
  const result = readJsonFile(session.resultPath)
  return { outcome, result, failure: describeFailure(outcome, result) }
}

/** Format one cutout record as a single report line. */
function formatRecord(record) {
  if (record.ok) {
    const size = record.width !== undefined ? `${record.width}x${record.height}` : '?'
    const source = record.sourceWidth !== undefined ? `${record.sourceWidth}x${record.sourceHeight} -> ` : ''
    const alpha = record.hasAlpha === true ? 'alpha' : record.hasAlpha === false ? 'NO ALPHA' : 'unchecked'
    const notes = []
    if (typeof record.warning === 'string') notes.push(`warning: ${record.warning}`)
    if (typeof record.trimWarning === 'string') notes.push(`trim warning: ${record.trimWarning}`)
    if (typeof record.featherWarning === 'string') notes.push(`feather warning: ${record.featherWarning}`)
    return `[ok]   ${basename(record.input)} -> ${basename(record.output)}  ${source}${size} (${alpha})${notes.length > 0 ? `  ${notes.join('; ')}` : ''}`
  }
  return `[FAIL] ${basename(record.input)}: ${record.error ?? 'unknown error'}`
}

/**
 * Register the Photoshop tools and, when the registry exists, the prompt
 * section that tells the model how to sequence them.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const tools = ctx.tools

  tools.register(
    defineTool({
      name: 'photoshop_status',
      description:
        'Report the local Adobe Photoshop installation and whether it can be scripted: version and build, how many documents are open, whether the Select Subject and Remove Background commands exist in this version, and whether Photoshop is currently running. Read-only; call it first when a Photoshop task fails for an unexplained reason.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 300000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const session = createSession()
        try {
          const running = isPhotoshopRunning()
          // A stopped Photoshop has to be launched by the COM attach, which
          // takes far longer than attaching to a running one.
          const budget = running === 'running' ? 180000 : 420000
          const { outcome, result, failure } = await roundTrip(session, statusScript({ resultPath: session.resultPath }), {
            timeoutMs: budget,
            signal: exec.signal,
          })
          if (failure !== '') return `Photoshop status unavailable.\n${failure}`
          const lines = []
          lines.push(`Adobe Photoshop ${result.photoshop.version} (build ${result.photoshop.build})`)
          lines.push(`engine: ${result.photoshop.engine}`)
          lines.push(`process: ${running === 'running' ? 'already running' : running === 'stopped' ? 'was not running (this call started it)' : 'running state unknown'}`)
          lines.push(`documents open: ${result.documentsOpen}${result.openDocuments?.length > 0 ? ` (${result.openDocuments.join(', ')})` : ''}`)
          lines.push(`select subject available: ${result.capabilities.selectSubject === true ? 'yes' : 'NO'}`)
          lines.push(`remove background available: ${result.capabilities.removeBackground === true ? 'yes' : 'NO'}`)
          lines.push(`recipes: ${(result.recipes ?? []).join(', ')}`)
          if (result.documentsOpen > 0) {
            lines.push('note: open documents are never touched — this plugin only closes documents it opened itself, and never saves over an input file.')
          }
          return lines.join('\n')
        } finally {
          session.cleanup()
        }
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'photoshop_inspect',
      description:
        'Report what is currently open in Photoshop: every open document, and for one of them its size, resolution, colour mode, profile, unsaved state, current selection, history position, and the complete layer tree — each layer’s kind, name, visibility, opacity, blend mode, mask, layer effects, clipping and bounds, plus text content for text layers. Read-only. Call this before any operation that has to name a layer or check the current state, instead of guessing at layer names.',
      parameters: {
        document: {
          type: 'string',
          description: 'Exact name of the open document to inspect. Omit it to inspect the active document.',
        },
        max_layers: {
          type: 'number',
          description: `Stop after this many layers (default ${MAX_INSPECTED_LAYERS}).`,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 300000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const session = createSession()
        try {
          const running = isPhotoshopRunning()
          const budget = running === 'running' ? 180000 : 420000
          const { result, failure } = await roundTrip(
            session,
            inspectScript({
              resultPath: session.resultPath,
              documentName: typeof args.document === 'string' && args.document.trim() !== '' ? args.document.trim() : undefined,
              maxLayers:
                Number.isFinite(args.max_layers) && args.max_layers > 0
                  ? Math.floor(args.max_layers)
                  : MAX_INSPECTED_LAYERS,
            }),
            { timeoutMs: budget, signal: exec.signal },
          )
          if (failure !== '') return `Photoshop inspection unavailable.\n${failure}`
          return formatInspectReport(result)
        } finally {
          session.cleanup()
        }
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'photoshop_cutout',
      description:
        'Cut the subject out of images with the local Photoshop and write transparent PNGs. Accepts files and/or directories, runs the whole batch inside one Photoshop session, and verifies that every output really carries an alpha channel. mode "select-subject" runs Photoshop\'s Select Subject (best for people, products, animals); "remove-background" runs Remove Background and keeps its mask. Optionally trims the transparent margin and caps the longest side.',
      parameters: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Input image files and/or directories to scan for images. Directories are read one level deep unless recursive is true.',
        },
        output_dir: {
          type: 'string',
          required: true,
          description: 'Directory the transparent PNGs are written to. Created when missing.',
        },
        mode: {
          type: 'string',
          enum: ['select-subject', 'remove-background'],
          description: 'Which Photoshop command performs the cutout. Defaults to select-subject.',
        },
        recursive: { type: 'boolean', description: 'Walk input directories to any depth. Defaults to false.' },
        trim: {
          type: 'boolean',
          description: 'Trim the transparent margin so each PNG hugs its subject. Defaults to true.',
        },
        feather_px: {
          type: 'number',
          description: 'Soften the cut edge by this many pixels before clearing the background. 0 (default) keeps Photoshop\'s hard edge.',
        },
        max_side: {
          type: 'number',
          description: 'Downscale so the longest side is at most this many pixels. 0 (default) keeps the original size.',
        },
        suffix: { type: 'string', description: 'Text inserted before ".png" in each output name.' },
        overwrite: { type: 'boolean', description: 'Replace existing output files. Defaults to false, which skips them and says so.' },
        limit: {
          type: 'number',
          description: `Process at most this many images in one call (hard cap ${MAX_BATCH_FILES}). Use it to try a batch on a few frames first.`,
        },
        timeout_ms: {
          type: 'number',
          description: 'Cooperative time budget for the whole batch in milliseconds. Raise it for hundreds of images.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: defaultTimeoutMs(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const outputDir = resolve(args.output_dir)
        const { files, missing } = collectImages(args.paths, args.recursive === true)
        const mode = args.mode ?? 'select-subject'
        const limit = Math.min(Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : MAX_BATCH_FILES, MAX_BATCH_FILES)

        if (files.length === 0) {
          const detail = missing.length > 0 ? ` Paths not found: ${missing.join(', ')}.` : ''
          return `No input images found.${detail} Supported extensions include .jpg .jpeg .png .tif .tiff .bmp .psd .webp.`
        }
        const selected = files.slice(0, limit)
        try {
          mkdirSync(outputDir, { recursive: true })
        } catch (error) {
          return `Could not create the output directory ${outputDir}: ${error?.message ?? String(error)}`
        }

        const { pairs, skipped } = planOutputs(selected, outputDir, args.suffix ?? '', args.overwrite === true)
        if (pairs.length === 0) {
          return `Nothing to do: all ${skipped.length} output file(s) already exist in ${outputDir}. Pass overwrite: true to replace them.`
        }

        const session = createSession()
        try {
          const jsx = cutoutScript({
            mode,
            pairs,
            trim: args.trim !== false,
            featherPx: Number.isFinite(args.feather_px) && args.feather_px > 0 ? args.feather_px : 0,
            maxSide: Number.isFinite(args.max_side) && args.max_side > 0 ? args.max_side : 0,
            resultPath: session.resultPath,
            progressPath: session.progressPath,
            cancelPath: session.cancelPath,
          })
          const { outcome, result, failure } = await roundTrip(session, jsx, {
            timeoutMs: Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : defaultTimeoutMs(),
            signal: exec.signal,
            gracefulCancel: true,
          })

          const records = result?.results ?? []
          // The recipe verifies nothing about transparency; the PNG header can.
          for (const record of records) {
            if (record.ok === true && typeof record.output === 'string') {
              const info = readPngInfo(record.output)
              if (info !== undefined) {
                record.hasAlpha = info.hasAlpha
                record.width = info.width
                record.height = info.height
              }
            }
          }

          const lines = [`Photoshop cutout — mode ${mode}, ${pairs.length} image(s) queued`]
          if (failure !== '') lines.push(`bridge: ${failure}`)
          if (result?.cancelled === true) lines.push('cancelled early; the images listed below were already finished')
          if (records.length < pairs.length) {
            lines.push(`only ${records.length} of ${pairs.length} image(s) were reached — Photoshop stopped early`)
          }

          const succeeded = records.filter((record) => record.ok === true)
          const failed = records.filter((record) => record.ok !== true)
          const opaque = succeeded.filter((record) => record.hasAlpha === false)
          lines.push(`succeeded ${succeeded.length}, failed ${failed.length}, skipped ${skipped.length}`)
          lines.push(`output: ${outputDir}`)

          for (const record of records.slice(0, REPORT_ITEM_LIMIT)) lines.push(formatRecord(record))
          if (records.length > REPORT_ITEM_LIMIT) lines.push(`...and ${records.length - REPORT_ITEM_LIMIT} more`)
          for (const entry of skipped.slice(0, REPORT_ITEM_LIMIT)) {
            lines.push(`[skip] ${basename(entry.input)}: ${entry.reason}`)
          }
          if (opaque.length > 0) {
            lines.push(
              `warning: ${opaque.length} output(s) have no alpha channel — the cutout did not take effect for those images. Try mode "remove-background" for them.`,
            )
          }
          if (missing.length > 0) lines.push(`note: these input paths did not exist: ${missing.join(', ')}`)
          return lines.join('\n')
        } finally {
          session.cleanup()
        }
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'photoshop_apply',
      description:
        'Run a plan of named operations against the open Photoshop documents, in order. This is the general-purpose Photoshop tool: document setup and resizing, layer creation, naming, ordering, grouping, masks, opacity, blend modes and layer styles, tonal and colour adjustments, filters, text, fills, selections and history. The whole plan runs inside one Photoshop session and, when a document is already open, collapses into a single undo step. Each operation names the document and layer it applies to, or works on the active ones. Call photoshop_reference for the full list of operations and their fields, and photoshop_inspect first when the plan has to name a layer.',
      parameters: {
        ops: {
          type: 'array',
          items: { type: 'json' },
          required: true,
          description:
            'The operations, in execution order. Each is an object with an "op" field naming the operation plus its fields, e.g. [{ "op": "resize_image", "max_side": 1600 }, { "op": "save_as", "path": "D:/out.png" }].',
        },
        document: {
          type: 'string',
          description:
            'Default document name for every operation that does not name one itself. Omit it to work on the active document. Ignored by "open" and "new_document", which choose their own.',
        },
        step_name: {
          type: 'string',
          description: 'Label for the undo step this plan becomes, so the user sees what a single undo will revert.',
        },
        single_undo_step: {
          type: 'boolean',
          description:
            'Wrap the whole plan in one undo step (default true). Set false when the plan itself works with history — step_backward, step_forward — or when each operation should be separately undoable.',
        },
        timeout_ms: { type: 'number', description: 'Cooperative time budget for the plan in milliseconds.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: defaultTimeoutMs(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const requested = Array.isArray(args.ops) ? args.ops : []
        const problem = validatePlan(requested)
        if (problem !== '') return problem

        const fallbackDocument =
          typeof args.document === 'string' && args.document.trim() !== '' ? args.document.trim() : undefined
        const plan = requested.map((op) =>
          fallbackDocument !== undefined && op.document === undefined && op.op !== 'open' && op.op !== 'new_document'
            ? { ...op, document: fallbackDocument }
            : op,
        )

        const session = createSession()
        try {
          const { result, failure } = await roundTrip(
            session,
            applyScript({
              resultPath: session.resultPath,
              ops: plan,
              stepName:
                typeof args.step_name === 'string' && args.step_name.trim() !== '' ? args.step_name.trim() : undefined,
              group: args.single_undo_step !== false,
            }),
            {
              timeoutMs: Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : defaultTimeoutMs(),
              signal: exec.signal,
            },
          )
          if (result === undefined) return `Photoshop did not return a result for this plan.\n${failure}`
          return formatApplyReport(result, plan)
        } finally {
          session.cleanup()
        }
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'photoshop_reference',
      description:
        'List the operations that photoshop_apply accepts, with the fields each one takes and what it does. Call this when a Photoshop task needs an operation you are not certain about, or to discover what is possible. Returns the whole vocabulary, or one group of it. Requires no running Photoshop.',
      parameters: {
        group: {
          type: 'string',
          enum: VOCABULARY.map((section) => section.group),
          description: 'Return only this group. Omit for the complete vocabulary.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const group = typeof args.group === 'string' && args.group.trim() !== '' ? args.group.trim() : undefined
        return formatReference(group)
      },
    }),
  )

  tools.register(
    defineTool({
      name: 'photoshop_run_jsx',
      description:
        'Run arbitrary ExtendScript inside the local Photoshop and return what the script evaluates to. This is the escape hatch for anything without a dedicated tool: batch actions, layer work, resizing, applying recorded actions, or inspecting the document. The script runs with Photoshop\'s scripting DOM (app, documents, executeAction) and its return value is reported as text, so end a script with the value you want back. Modal dialogs are suppressed and restored, and no document the script did not open is closed.',
      parameters: {
        script: { type: 'string', description: 'ExtendScript source to evaluate. Its result value is returned.' },
        path: { type: 'string', description: 'Path to a .jsx file to run instead of inline script. Ignored when script is given.' },
        timeout_ms: { type: 'number', description: 'Cooperative time budget in milliseconds.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: defaultTimeoutMs(),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        let code = typeof args.script === 'string' ? args.script : ''
        if (code.trim() === '' && typeof args.path === 'string' && args.path.trim() !== '') {
          const file = resolve(args.path)
          try {
            code = readFileSync(file, 'utf8')
          } catch (error) {
            return `Could not read ${file}: ${error?.message ?? String(error)}`
          }
        }
        if (code.trim() === '') return 'Nothing to run: pass either script (source) or path (a .jsx file).'

        const session = createSession()
        try {
          const { outcome, result, failure } = await roundTrip(session, rawScript({ code, resultPath: session.resultPath }), {
            timeoutMs: Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : defaultTimeoutMs(),
            signal: exec.signal,
          })
          if (failure !== '') return `Photoshop script failed.\n${failure}`
          const lines = []
          const value = result?.result
          if (result?.ok !== true) {
            lines.push('Photoshop reported a script error.')
            if (result?.error !== undefined) lines.push(String(result.error))
            if (result?.errorLine !== undefined) lines.push(`line ${result.errorLine}`)
            return lines.join('\n')
          }
          lines.push(value === null || value === undefined ? '(script returned no value)' : String(value))
          if (result?.documentsOpen !== undefined) lines.push(`documents open after the call: ${result.documentsOpen}`)
          return lines.join('\n')
        } finally {
          session.cleanup()
        }
      },
    }),
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'tool:photoshop',
      order: PROMPT_SECTION_ORDER,
      text:
        'The photoshop_cutout tool drives the user\'s own Adobe Photoshop (Windows, COM automation) to cut subjects out of images and write transparent PNGs. Prefer it over any open-source matting model: Photoshop\'s Select Subject is markedly better on people and products. For a batch, pass files or directories in one call rather than one call per image — the batch runs inside a single Photoshop session. Frames for it come from the user\'s own extraction step. Use photoshop_status first when a Photoshop call fails for a non-obvious reason, and photoshop_run_jsx for Photoshop work no dedicated tool covers.',
    })
  }
}
