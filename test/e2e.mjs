/**
 * dsh-plugin-photoshop — end-to-end check against the real Photoshop.
 *
 * This exercises everything except Cordis itself: it builds the tool
 * definitions through `lib/tool.js`, registers them on a stand-in registry,
 * then calls the tools' `execute` exactly as the tool runtime would. That is
 * the whole path that matters — schema compilation, the PowerShell/COM bridge,
 * the generated ExtendScript, the batch loop, and the finished PNG's alpha.
 *
 * Run with:  node test/e2e.mjs [source-image]
 * The plan is printed either way, and inputs land in `_research/e2e/` so the
 * cutouts can be looked at afterwards.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const WORKSPACE = join(import.meta.dirname, '..')
const SANDBOX = join(WORKSPACE, '_research', 'e2e')
const INPUT_DIR = join(SANDBOX, 'in')
const OUTPUT_DIR = join(SANDBOX, 'out')

/** Registry stand-in: the tool runtime calls exactly this and nothing else. */
const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  get() {
    return undefined
  },
}

function line(text = '') {
  process.stdout.write(`${text}\n`)
}

function heading(text) {
  line()
  line(`── ${text} ${'─'.repeat(Math.max(0, 62 - text.length))}`)
}

/** Invoke one registered tool the way the runtime does. */
async function callTool(toolName, args) {
  const definition = registered.get(toolName)
  if (definition === undefined) throw new Error(`tool ${toolName} was not registered`)
  return definition.execute(args, { signal: undefined })
}

function prepareInputs() {
  mkdirSync(join(INPUT_DIR, 'nested'), { recursive: true })
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const explicit = process.argv[2]
  const source = explicit ?? join(homedir(), 'Pictures', '1.jpg')
  if (!existsSync(source)) {
    throw new Error(`no test image: give one as an argument (looked for ${source})`)
  }
  copyFileSync(source, join(INPUT_DIR, 'sample-a.jpg'))
  copyFileSync(source, join(INPUT_DIR, 'sample-b.jpg'))
  copyFileSync(source, join(INPUT_DIR, 'nested', 'sample-c.jpg'))
  return source
}

async function main() {
  heading('registering tools')
  apply(ctx)
  for (const definition of registered.values()) {
    const properties = Object.keys(definition.parameters.properties ?? {})
    line(`${definition.name}: ${properties.length} parameter(s)${properties.length > 0 ? ` [${properties.join(', ')}]` : ''}, timeoutMs=${definition.timeoutMs}`)
  }

  heading('inputs')
  const source = prepareInputs()
  line(`copied ${source} into three inputs:`)
  line(`  ${INPUT_DIR}`)
  line('  └─ sample-a.jpg, sample-b.jpg, nested/sample-c.jpg')

  if (process.env.DSH_PHOTOSHOP_SKIP_STATUS !== '1') {
    heading('photoshop_status')
    line(await callTool('photoshop_status', {}))
  }

  heading('photoshop_cutout — select-subject, recursive, trim')
  const report = await callTool('photoshop_cutout', {
    paths: [INPUT_DIR],
    output_dir: OUTPUT_DIR,
    mode: 'select-subject',
    recursive: true,
    trim: true,
    timeout_ms: 600000,
  })
  line(report)

  heading('photoshop_cutout — rerun without overwrite')
  line(await callTool('photoshop_cutout', {
    paths: [INPUT_DIR],
    output_dir: OUTPUT_DIR,
    recursive: true,
    timeout_ms: 300000,
  }))

  heading('photoshop_run_jsx — the escape hatch')
  line(await callTool('photoshop_run_jsx', {
    script: "app.name + ' v' + app.version + ' | docs open: ' + app.documents.length",
    timeout_ms: 180000,
  }))

  const failures = []
  if (!/\[ok\]/.test(report)) failures.push('no successful cutout in the report')
  if (!/alpha\b/.test(report)) failures.push('no alpha verification line in the report')
  if (/NO ALPHA/.test(report)) failures.push('an output PNG came back without an alpha channel')
  if (/bridge:/.test(report)) failures.push('the bridge reported a failure')

  heading('verdict')
  if (failures.length === 0) {
    line('PASS — cutouts ran through Photoshop and every output is a transparent PNG.')
    line(`look at them in ${OUTPUT_DIR}`)
  } else {
    for (const failure of failures) line(`FAIL — ${failure}`)
    process.exitCode = 1
  }
  line()
  line(`(remove ${SANDBOX} when you are done looking)`)
}

main().catch((error) => {
  process.stderr.write(`\n e2e crashed: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
})
