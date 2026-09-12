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

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { applyScript } from '../lib/ops-jsx.js'
import { describeEdge, readPngStats } from '../lib/png.js'
import { createSession, readJsonFile } from '../lib/ps.js'
import { OPERATION_NAMES } from '../lib/vocabulary.js'

const WORKSPACE = join(import.meta.dirname, '..')
const SANDBOX = join(WORKSPACE, '_research', 'e2e')
const INPUT_DIR = join(SANDBOX, 'in')
const OUTPUT_DIR = join(SANDBOX, 'out')
const BATCH_OUT = join(SANDBOX, 'batch-out')
const LAYERS_OUT = join(SANDBOX, 'layers-out')
const NESTED_OUT = join(SANDBOX, 'nested', 'deeper', 'made-on-demand')
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
  rmSync(BATCH_OUT, { recursive: true, force: true })
  rmSync(LAYERS_OUT, { recursive: true, force: true })
  rmSync(join(SANDBOX, 'nested'), { recursive: true, force: true })
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

/**
 * Ask Photoshop which operation handlers it actually compiled. This is what
 * keeps `lib/vocabulary.js` honest: the documented list and the implemented
 * list have to be the same list.
 * @returns the handler names and how the round trip ended.
 */
async function fetchHandlerNames() {
  const session = createSession()
  try {
    const outcome = await session.run(
      applyScript({ resultPath: session.resultPath, listOperations: true }),
      { timeoutMs: 180000 },
    )
    const result = readJsonFile(session.resultPath)
    return { names: Array.isArray(result?.operations) ? result.operations : [], status: outcome.status }
  } finally {
    session.cleanup()
  }
}

async function main() {
  const failures = []
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

  heading('clearing documents left behind by an earlier run')
  line(await callTool('photoshop_run_jsx', {
    script: `var closed = [];
for (var i = app.documents.length - 1; i >= 0; i--) {
  var docName = String(app.documents[i].name);
  if (docName.indexOf('dsh-') === 0 || docName.indexOf('fixture') >= 0) {
    closed.push(docName);
    app.documents[i].close(SaveOptions.DONOTSAVECHANGES);
  }
}
closed.length === 0 ? 'nothing left over' : 'closed: ' + closed.join(', ')`,
    timeout_ms: 300000,
  }))

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

  heading('photoshop_cutout — edge refinement, measured')
  const refined = await callTool('photoshop_cutout', {
    paths: [join(INPUT_DIR, 'sample-a.jpg')],
    output_dir: OUTPUT_DIR,
    mode: 'select-subject',
    suffix: '-refined',
    feather_px: 2,
    contract_px: 1,
    mask_blur_px: 1,
    timeout_ms: 300000,
  })
  line(refined)
  const plainStats = readPngStats(join(OUTPUT_DIR, 'sample-a.png'))
  const refinedStats = readPngStats(join(OUTPUT_DIR, 'sample-a-refined.png'))
  line(`  plain cutout edge:   ${describeEdge(plainStats)}`)
  line(`  refined cutout edge: ${describeEdge(refinedStats)}`)
  if (plainStats === undefined || refinedStats === undefined) {
    failures.push('edge statistics could not be read from the cutout outputs')
  } else if (refinedStats.partial <= plainStats.partial) {
    failures.push(
      `refinement did not soften the edge: ${refinedStats.partial} partial pixel(s) against ${plainStats.partial} unrefined`,
    )
  } else {
    line(`  refinement added ${refinedStats.partial - plainStats.partial} partial pixel(s) to the outline`)
  }

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

  // ── photoshop_apply ───────────────────────────────────────────────────────
  heading('photoshop_apply — the vocabulary and Photoshop must agree')
  const handlers = await fetchHandlerNames()
  const implemented = new Set(handlers.names)
  const documented = new Set(OPERATION_NAMES)
  const undocumented = OPERATION_NAMES.filter((name) => !implemented.has(name))
  const unimplemented = handlers.names.filter((name) => !documented.has(name))
  line(`documented: ${OPERATION_NAMES.length}   implemented in Photoshop: ${handlers.names.length}`)
  if (handlers.names.length === 0) {
    failures.push(`Photoshop reported no operation handlers (bridge: ${handlers.status})`)
  } else if (undocumented.length === 0 && unimplemented.length === 0) {
    line('they agree on every operation')
  } else {
    if (documented.size > 0) line(`documented but missing a handler: ${undocumented.join(', ') || '(none)'}`)
    if (unimplemented.length > 0) line(`handler with no documentation: ${unimplemented.join(', ') || '(none)'}`)
    if (undocumented.length > 0) failures.push(`${undocumented.length} documented operation(s) have no handler: ${undocumented.join(', ')}`)
    if (unimplemented.length > 0) failures.push(`${unimplemented.length} handler(s) are undocumented: ${unimplemented.join(', ')}`)
  }

  const planFailures = []
  const runPlan = async (label, ops, options = {}) => {
    heading(label)
    const result = await callTool('photoshop_apply', { ops, ...options })
    line(result)
    if (!/^Applied \d+ operation/.test(result)) planFailures.push(label)
    return result
  }

  await runPlan('photoshop_apply — document setup and paint (nothing was open)', [
    { op: 'new_document', width: 320, height: 240, resolution: 72, name: 'dsh-apply-fixture', fill: 'white' },
    { op: 'add_layer', name: 'Canvas' },
    { op: 'fill', color: '#3b7dd8' },
    { op: 'add_text', contents: 'Apply works', name: 'Caption', size: 22, color: '#102030', x: 24, y: 48 },
    { op: 'add_group', name: 'Stack' },
    { op: 'move_layer', target: 'Caption', into: 'Stack' },
    { op: 'save_as', path: `${SANDBOX}/apply-a.png`, format: 'png', overwrite: true },
  ])

  await runPlan('photoshop_apply — layers, masks and layer styles (one undo step)', [
    { op: 'add_layer', name: 'Banner' },
    { op: 'fill', color: '#e8b000' },
    { op: 'set_opacity', target: 'Banner', value: 85 },
    { op: 'set_fill_opacity', target: 'Banner', value: 90 },
    { op: 'set_blend_mode', target: 'Banner', mode: 'multiply' },
    { op: 'add_mask', target: 'Banner', mode: 'reveal_all' },
    { op: 'refine_mask', target: 'Banner', blur_px: 2 },
    { op: 'invert_mask', target: 'Banner' },
    { op: 'invert_mask', target: 'Banner' },
    { op: 'layer_style', target: 'Banner', style: 'drop_shadow', distance: 5, size: 7, opacity: 50 },
    { op: 'layer_style', target: 'Banner', style: 'stroke', width: 3, color: '#ff2d55' },
    { op: 'duplicate_layer', target: 'Banner', name: 'Banner copy' },
    { op: 'rename_layer', target: 'Banner copy', name: 'Hidden copy' },
    { op: 'set_visibility', target: 'Hidden copy', visible: false },
    { op: 'delete_layer', target: 'Hidden copy' },
    { op: 'clipping_mask', target: 'Banner', enabled: true },
    { op: 'clipping_mask', target: 'Banner', enabled: false },
    { op: 'delete_mask', target: 'Banner' },
  ])

  await runPlan('photoshop_apply — groups, smart objects and fill layers', [
    { op: 'add_color_layer', color: '#22aa66', name: 'Green' },
    { op: 'add_group', name: 'Outer' },
    { op: 'move_layer', target: 'Green', into: 'Outer' },
    { op: 'ungroup', target: 'Outer' },
    { op: 'to_smart_object', target: 'Banner' },
    { op: 'rasterize', target: 'Banner' },
  ])

  heading('photoshop_inspect — the document the plans have been building')
  line(await callTool('photoshop_inspect', {}))

  await runPlan('photoshop_apply — selections, adjustments and filters', [
    { op: 'select_all' },
    { op: 'contract', pixels: 24 },
    { op: 'feather', pixels: 5 },
    { op: 'fill', target: 'Canvas', color: '#ffffff' },
    { op: 'save_selection', name: 'dsh-inset' },
    { op: 'deselect' },
    { op: 'load_selection', name: 'dsh-inset' },
    { op: 'deselect' },
    { op: 'levels', target: 'Banner', input_black: 12, input_white: 244, gamma: 1.1 },
    { op: 'brightness_contrast', target: 'Banner', brightness: 5, contrast: 10 },
    { op: 'hue_saturation', target: 'Banner', hue: 25, saturation: 20, lightness: -5 },
    { op: 'vibrance', target: 'Banner', vibrance: 15, saturation: 5 },
    { op: 'black_white', target: 'Banner' },
    { op: 'auto_levels', target: 'Banner' },
    { op: 'auto_contrast', target: 'Banner' },
    { op: 'desaturate', target: 'Banner' },
    { op: 'invert', target: 'Banner' },
    { op: 'threshold', target: 'Banner', level: 128 },
    { op: 'posterize', target: 'Banner', levels: 6 },
    { op: 'equalize', target: 'Banner' },
    { op: 'gaussian_blur', target: 'Banner', radius: 2.5 },
    { op: 'motion_blur', target: 'Banner', angle: 30, distance: 8 },
    { op: 'radial_blur', target: 'Banner', amount: 8 },
    { op: 'smart_blur', target: 'Banner', radius: 3, threshold: 12 },
    { op: 'unsharp_mask', target: 'Banner', amount: 70, radius: 1.5, threshold: 3 },
    { op: 'sharpen', target: 'Banner' },
    { op: 'sharpen_more', target: 'Banner' },
    { op: 'sharpen_edges', target: 'Banner' },
    { op: 'add_noise', target: 'Banner', amount: 6 },
    { op: 'median_noise', target: 'Banner', radius: 2 },
    { op: 'dust_and_scratches', target: 'Banner', radius: 2, threshold: 4 },
    { op: 'despeckle', target: 'Banner' },
    { op: 'high_pass', target: 'Banner', radius: 3 },
    { op: 'maximum', target: 'Banner', radius: 2 },
    { op: 'minimum', target: 'Banner', radius: 2 },
    { op: 'offset', target: 'Banner', horizontal: 6, vertical: 4 },
    {
      op: 'custom_filter',
      target: 'Banner',
      kernel: [0, 0, 0, 0, 0, 0, -1, -1, -1, 0, 0, -1, 9, -1, 0, 0, -1, -1, -1, 0, 0, 0, 0, 0, 0],
    },
    { op: 'pinch', target: 'Banner', amount: 15 },
    { op: 'spherize', target: 'Banner', amount: 15 },
    { op: 'twirl', target: 'Banner', angle: 30 },
    { op: 'invert_selection' },
    { op: 'deselect' },
    { op: 'select_subject' },
    { op: 'deselect' },
    { op: 'select_sky' },
    { op: 'deselect' },
  ])

  await runPlan(
    'photoshop_apply — history, metadata and document reshaping (not one undo step)',
    [
      { op: 'add_layer', name: 'Temp' },
      { op: 'delete_layer', target: 'Temp' },
      { op: 'step_backward', steps: 1 },
      { op: 'step_forward', steps: 1 },
      { op: 'set_metadata', title: 'DSH apply fixture', author: 'dsh-plugin-photoshop', copyright: 'test asset' },
      { op: 'resize_image', max_side: 200 },
      { op: 'rotate_canvas', angle: 90 },
      { op: 'flip_canvas', axis: 'horizontal' },
      { op: 'resize_canvas', width: 260, height: 260, anchor: 'center' },
      { op: 'crop', left: 10, top: 10, right: 210, bottom: 210 },
      { op: 'save_as', path: `${SANDBOX}/apply-d.jpg`, format: 'jpeg', quality: 8, overwrite: true },
      { op: 'convert_profile', profile: 'sRGB IEC61966-2.1' },
      { op: 'change_mode', mode: 'grayscale' },
      { op: 'save_as', path: `${SANDBOX}/apply-d-gray.png`, format: 'png', overwrite: true },
    ],
    { single_undo_step: false },
  )

  await runPlan(
    'photoshop_apply — transparency, clearing and trim',
    [
      { op: 'new_document', width: 200, height: 200, name: 'dsh-trim-fixture', fill: 'transparent' },
      { op: 'add_layer', name: 'Blob' },
      { op: 'select_all' },
      { op: 'contract', pixels: 60 },
      { op: 'fill', color: '#123456' },
      { op: 'deselect' },
      { op: 'trim', based_on: 'transparent' },
      { op: 'select_all' },
      { op: 'clear_selection' },
      { op: 'deselect' },
      { op: 'close', discard: true },
    ],
    { single_undo_step: false },
  )

  // ── photoshop_batch ───────────────────────────────────────────────────────
  heading('photoshop_batch — one plan, three files, one session')
  const batchReport = await callTool('photoshop_batch', {
    paths: [INPUT_DIR],
    ops: [
      { op: 'remove_background' },
      { op: 'trim', based_on: 'transparent' },
      { op: 'resize_image', max_side: 200 },
    ],
    output_dir: BATCH_OUT,
    output_format: 'png',
    recursive: true,
    timeout_ms: 600000,
  })
  line(batchReport)

  heading('photoshop_batch — the same plan as JPEG')
  const jpegReport = await callTool('photoshop_batch', {
    paths: [join(INPUT_DIR, 'sample-a.jpg')],
    ops: [{ op: 'resize_image', max_side: 120 }],
    output_dir: BATCH_OUT,
    output_format: 'jpeg',
    suffix: '-small',
    timeout_ms: 300000,
  })
  line(jpegReport)

  heading('photoshop_batch — a plan it must refuse')
  const refused = await callTool('photoshop_batch', {
    paths: [join(INPUT_DIR, 'sample-a.jpg')],
    ops: [{ op: 'save_as', path: `${BATCH_OUT}/nope.png` }],
    output_dir: BATCH_OUT,
    timeout_ms: 120000,
  })
  line(refused)
  if (!/"save_as" cannot appear in a batch plan/.test(refused)) {
    failures.push('a batch plan containing save_as was not refused')
  }

  heading('photoshop_apply — export_layers and list_actions')
  const exportReport = await callTool('photoshop_apply', {
    ops: [
      { op: 'export_layers', output_dir: LAYERS_OUT, format: 'png' },
      { op: 'list_actions' },
    ],
    single_undo_step: false,
    timeout_ms: 600000,
  })
  line(exportReport)
  const exported = existsSync(LAYERS_OUT) ? readdirSync(LAYERS_OUT) : []
  line(`files written: ${exported.length}${exported.length > 0 ? ` — ${exported.slice(0, 8).join(', ')}` : ''}`)
  if (!/^Applied 2 operations/.test(exportReport)) planFailures.push('export_layers / list_actions')
  if (exported.length < 3) failures.push(`export_layers wrote only ${exported.length} file(s) for a document with more layers than that`)
  if (!/action sets/.test(exportReport)) failures.push('list_actions did not report the action sets')

  heading('photoshop_apply — dry run, before touching anything')
  const beforeDry = await callTool('photoshop_inspect', {})
  const historyBefore = /history\s+(\d+) states/.exec(beforeDry)?.[1]
  const dryRun = await callTool('photoshop_apply', {
    ops: [
      { op: 'select_all' },
      { op: 'gaussian_blur', target: 'Canvas', radius: 2 },
      { op: 'gaussian_blur', target: 'NoSuchLayer', radius: 2 },
    ],
    dry_run: true,
    timeout_ms: 300000,
  })
  line(dryRun)
  const afterDry = await callTool('photoshop_inspect', {})
  const historyAfter = /history\s+(\d+) states/.exec(afterDry)?.[1]
  line(`history states before/after the dry run: ${historyBefore} / ${historyAfter}`)
  if (!/nothing applied/.test(dryRun)) failures.push('the dry run did not say that nothing was applied')
  if (!/FAIL/.test(dryRun)) failures.push('the dry run did not flag the operation naming a missing layer')
  if (!/target "NoSuchLayer"/.test(dryRun)) failures.push('the dry run did not name the reference it could not resolve')
  if (!/no layer named "NoSuchLayer"/.test(dryRun)) failures.push('the dry run did not explain why the reference failed')
  if (!/"Canvas"/.test(dryRun)) failures.push('the dry run did not report the layer it resolved')
  if (historyBefore !== undefined && historyAfter !== undefined && historyBefore !== historyAfter) {
    failures.push(`the dry run changed the document: history went from ${historyBefore} to ${historyAfter}`)
  }

  heading('photoshop_apply — save_as into a directory that does not exist yet')
  // Photoshop reports a missing directory as "the Save command's parameters are
  // currently invalid", which says nothing useful, so the plugin creates it first.
  const savePlan = await callTool('photoshop_apply', {
    ops: [
      { op: 'new_document', width: 40, height: 40, name: 'dsh-save-check' },
      { op: 'add_layer', name: 'Ink' },
      { op: 'fill', target: 'Ink', color: '#3366cc' },
      { op: 'save_as', path: `${NESTED_OUT.replace(/\\/g, '/')}/out.png`, format: 'png', overwrite: true },
      { op: 'close', discard: true },
    ],
    timeout_ms: 300000,
  })
  line(savePlan)
  line(`file written: ${existsSync(join(NESTED_OUT, 'out.png'))}`)
  if (!/^Applied 5 operations/.test(savePlan)) planFailures.push('save_as into a directory that does not exist')
  if (!existsSync(join(NESTED_OUT, 'out.png'))) failures.push('save_as did not create the missing directory and write the file')

  heading('photoshop_apply — a plan that must fail, and say why')
  const badLayer = await callTool('photoshop_apply', {
    ops: [{ op: 'gaussian_blur', target: 'NoSuchLayer', radius: 2 }],
  })
  line(badLayer)
  if (!/failed after 0 of 1 operation/.test(badLayer)) failures.push('a missing layer was not reported as a failed operation')
  if (!/no layer named "NoSuchLayer"/.test(badLayer)) failures.push('the missing-layer error did not name the layer or suggest photoshop_inspect')

  const badFields = await callTool('photoshop_apply', { ops: [{ op: 'resize_image' }] })
  line(badFields)
  if (!/needs width and height, or max_side/.test(badFields)) failures.push('an operation with missing fields did not explain what it needs')

  const typo = await callTool('photoshop_apply', { ops: [{ op: 'gausian_blur', radius: 2 }] })
  line(typo)
  if (!/Unknown operation "gausian_blur"/.test(typo)) failures.push('a misspelled operation was not rejected before reaching Photoshop')
  if (!/gaussian_blur/.test(typo)) failures.push('a misspelled operation was not offered a correction')

  await runPlan('photoshop_apply — close the fixture (discarding unsaved changes)', [
    { op: 'close', discard: true },
  ], { single_undo_step: false })

  heading('photoshop_run_jsx — the escape hatch')
  line(await callTool('photoshop_run_jsx', {
    script: "app.name + ' v' + app.version + ' | docs open: ' + app.documents.length",
    timeout_ms: 180000,
  }))

  for (const label of planFailures) failures.push(`the plan "${label}" did not apply cleanly`)
  if (!/succeeded 3, failed 0/.test(batchReport)) failures.push('the batch did not succeed on all three files')
  if (/\[FAIL\]/.test(batchReport)) failures.push('the batch reported a failed file')
  if (/NO ALPHA/.test(batchReport)) failures.push('a batch output that should have transparency came back opaque')
  if (!/succeeded 1, failed 0/.test(jpegReport)) failures.push('the JPEG batch did not succeed')
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
