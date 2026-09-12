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
const FIXTURE_PATH = join(SANDBOX, 'fixture.psd').replace(/\\/g, '/')

/**
 * Build a document that exercises every layer fact the inspection reports: a
 * pixel layer carrying a layer mask, a text layer moved inside a named group,
 * and the untouched background. Saved as a PSD and closed, so the test can
 * reopen it and inspect genuine on-disk state rather than something the
 * inspection itself produced.
 *
 * Each step is reported rather than thrown, so a fixture that only partly
 * builds still yields a diagnosis instead of a crash.
 * @returns ExtendScript source.
 */
function fixtureScript() {
  return `var target = new File(${JSON.stringify(FIXTURE_PATH)});
if (target.exists) target.remove();
var notes = [];
var doc = app.documents.add(200, 120, 72, 'dsh-inspect-fixture', NewDocumentMode.RGB, DocumentFill.WHITE);

var shape = doc.artLayers.add();
shape.name = 'Shape';
var colour = new SolidColor();
colour.rgb.red = 200; colour.rgb.green = 60; colour.rgb.blue = 60;
doc.selection.select([[10, 10], [100, 10], [100, 90], [10, 90]]);
doc.selection.fill(colour);
doc.selection.deselect();
// Not the background layer, so opacity is settable — exercises the reporting path.
shape.opacity = 80;

// Reveal All (UsrM/RvlA) adds a mask with no selection present; Reveal
// Selection (UsrM/RvlS) is the variant that requires one.
var maskDesc = new ActionDescriptor();
maskDesc.putClass(charIDToTypeID('Nw  '), charIDToTypeID('Chnl'));
var atRef = new ActionReference();
atRef.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Msk '));
maskDesc.putReference(charIDToTypeID('At  '), atRef);
maskDesc.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('UsrM'), charIDToTypeID('RvlA'));
try { executeAction(charIDToTypeID('Mk  '), maskDesc, DialogModes.NO); notes.push('mask=ok'); }
catch (maskError) { notes.push('mask=FAILED(' + maskError.message + ')'); }

var title = doc.artLayers.add();
title.kind = LayerKind.TEXT;
title.name = 'Title';
title.textItem.contents = 'Hello Inspect';
title.textItem.size = UnitValue(18, 'px');

var group = doc.layerSets.add();
group.name = 'Header';
try { title.move(group, ElementPlacement.INSIDE); notes.push('group=ok'); }
catch (groupError) { notes.push('group=FAILED(' + groupError.message + ')'); }

try {
  doc.saveAs(target, new PhotoshopSaveOptions(), true, Extension.LOWERCASE);
  notes.push('saved=ok');
} catch (saveError) { notes.push('saved=FAILED(' + saveError.message + ')'); }
try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { notes.push('close=' + closeError.message); }
'fixture: ' + notes.join(' | ')`
}

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
  // The run must be repeatable: a previous run's outputs would otherwise be
  // skipped as "already exists" and read as a failure.
  rmSync(OUTPUT_DIR, { recursive: true, force: true })
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

  heading('photoshop_cutout — remove-background, feather, max_side')
  const secondReport = await callTool('photoshop_cutout', {
    paths: [join(INPUT_DIR, 'sample-a.jpg')],
    output_dir: OUTPUT_DIR,
    mode: 'remove-background',
    suffix: '-rb',
    feather_px: 1,
    max_side: 300,
    timeout_ms: 300000,
  })
  line(secondReport)

  heading('photoshop_inspect — fixture with a group, a text layer and a mask')
  line(await callTool('photoshop_run_jsx', { script: fixtureScript(), timeout_ms: 300000 }))
  // Build the document, then reopen it so the inspection has something real to read.
  const opened = await callTool('photoshop_run_jsx', {
    script: `app.open(new File(${JSON.stringify(FIXTURE_PATH)})); app.activeDocument.name`,
    timeout_ms: 300000,
  })
  line(`opened for inspection: ${opened.split('\n')[0]}`)
  const inspection = await callTool('photoshop_inspect', {})
  line(inspection)
  line(await callTool('photoshop_run_jsx', {
    script: `var closed = 0;
for (var i = app.documents.length - 1; i >= 0; i--) {
  if (String(app.documents[i].name) === 'fixture.psd') { app.documents[i].close(SaveOptions.DONOTSAVECHANGES); closed++; }
}
'closed ' + closed + ', ' + app.documents.length + ' left open'`,
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
  if (!/\[ok\]/.test(secondReport)) failures.push('remove-background mode produced no successful cutout')
  if (/NO ALPHA/.test(secondReport)) failures.push('remove-background mode produced an opaque output')
  if (/feather warning|trim warning/.test(secondReport)) failures.push('feather_px or trim was rejected by this Photoshop')

  const inspectionChecks = [
    ['the document is identified', /Document "fixture\.psd"/],
    ['its dimensions are reported', /200x120/],
    ['its colour mode is reported', /RGB/],
    ['the pixel layer appears', /"Shape"/],
    ['its layer mask is detected', /mask/],
    ['the group appears', /"Header"/],
    ['the text layer appears', /"Title"/],
    ['its text content is read', /text "Hello Inspect"/],
    ['its text size is read', /18px/],
    ['the nested name path is built', /Header\/Title/],
    ['an index path is offered', /\b0(\.\d+)?\s/],
  ]
  for (const [label, pattern] of inspectionChecks) {
    if (!pattern.test(inspection)) failures.push(`inspect did not report that ${label}`)
  }

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
