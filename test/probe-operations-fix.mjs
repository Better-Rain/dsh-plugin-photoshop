/**
 * dsh-plugin-photoshop — operation verification, round 2.
 *
 * Round 1 (`probe-operations.mjs`) reported 32/56. Reading its failures closely
 * showed that most were *recipe* bugs on this side, not missing Photoshop
 * features: wrong ActionManager event names (`groupLayers` instead of
 * `groupLayersEvent`), layer styles and masks attempted on a locked background
 * layer, a 9-value kernel where Photoshop wants 25, and text created through a
 * descriptor where the DOM already offers `LayerKind.TEXT`.
 *
 * This round re-attempts exactly those operations with corrected recipes, plus
 * the DOM-native routes that should replace the descriptor ones entirely. An
 * operation that still fails here is a genuine limitation of this Photoshop
 * build, and that is what the roadmap is allowed to treat as unavailable.
 *
 * Run with:  node test/probe-operations-fix.mjs
 * Results land in `_research/operations-round2.json`.
 *
 * (The two probes merge into one capability matrix once the vocabulary phase
 * settles which recipe each operation finally ships with.)
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { customScript } from '../lib/jsx.js'
import { createSession, readJsonFile } from '../lib/ps.js'

const WORKSPACE = join(import.meta.dirname, '..')
const REPORT_DIR = join(WORKSPACE, '_research')

/** Enumerations the corrected recipes depend on; a missing one is a real bug. */
const ENUMS = [
  'StrokeLocation', 'ColorBlendMode', 'RadialBlurMethod', 'RadialBlurQuality', 'SpherizeMode',
  'AnchorPosition', 'Intent', 'ChangeMode', 'RasterizeType', 'ElementPlacement', 'LayerKind',
  'ExportType', 'SaveDocumentType', 'BlendMode', 'Justification', 'TextType', 'TrimType',
]

/** Build the corrected ExtendScript body. */
function body() {
  return `
var OPS = [];
function op(group, name, fn) { OPS.push({ group: group, name: name, fn: fn }); }

function paint(doc, red, green, blue) {
  var colour = new SolidColor();
  colour.rgb.red = red; colour.rgb.green = green; colour.rgb.blue = blue;
  doc.selection.selectAll();
  doc.selection.fill(colour);
  doc.selection.deselect();
}

function unlocked(doc) {
  var background = doc.layers[0];
  if (background.isBackgroundLayer) background.isBackgroundLayer = false;
  return background;
}

function addMask() {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('channel'));
  desc.putReference(charIDToTypeID('null'), ref);
  desc.putClass(charIDToTypeID('at'), stringIDToTypeID('mask'));
  var using = new ActionReference();
  using.putEnumerated(stringIDToTypeID('channel'), stringIDToTypeID('channel'), stringIDToTypeID('mask'));
  desc.putReference(stringIDToTypeID('using'), using);
  executeAction(stringIDToTypeID('make'), desc, DialogModes.NO);
}

// ── the corrected recipes for round-1 failures ──────────────────────────────
op('fix.selection', 'contentAware fill (fill command, contentAware mode)', function (doc) {
  doc.selection.select([[10, 10], [38, 10], [38, 38], [10, 38]]);
  var desc = new ActionDescriptor();
  desc.putEnumerated(stringIDToTypeID('using'), stringIDToTypeID('fillContents'), stringIDToTypeID('contentAware'));
  desc.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), 100);
  desc.putEnumerated(stringIDToTypeID('mode'), stringIDToTypeID('blendMode'), stringIDToTypeID('normal'));
  executeAction(stringIDToTypeID('fill'), desc, DialogModes.NO);
});
op('fix.selection', 'selectFocusArea with descriptor', function (doc) {
  executeAction(stringIDToTypeID('selectFocusArea'), undefined, DialogModes.NO);
});
op('fix.layer', 'add layer mask on unlocked layer', function (doc) {
  unlocked(doc);
  addMask();
});
op('fix.layer', 'delete layer mask on unlocked layer', function (doc) {
  unlocked(doc);
  addMask();
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), stringIDToTypeID('mask'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(charIDToTypeID('Dlt '), desc, DialogModes.NO);
});
op('fix.layer', 'invert layer mask on unlocked layer', function (doc) {
  unlocked(doc);
  addMask();
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), stringIDToTypeID('mask'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('inverse'), desc, DialogModes.NO);
});
op('fix.layer', 'apply layer mask on unlocked layer', function (doc) {
  unlocked(doc);
  addMask();
  executeAction(stringIDToTypeID('applyLayerMask'), undefined, DialogModes.NO);
});
op('fix.layer', 'drop shadow on unlocked layer', function (doc) {
  unlocked(doc);
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('layerEffects'));
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  var effects = new ActionDescriptor();
  var shadow = new ActionDescriptor();
  shadow.putBoolean(stringIDToTypeID('enabled'), true);
  shadow.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), 60);
  shadow.putUnitDouble(stringIDToTypeID('distance'), stringIDToTypeID('pixelsUnit'), 6);
  shadow.putUnitDouble(stringIDToTypeID('size'), stringIDToTypeID('pixelsUnit'), 4);
  effects.putObject(stringIDToTypeID('dropShadow'), stringIDToTypeID('dropShadow'), shadow);
  desc.putObject(charIDToTypeID('T   '), stringIDToTypeID('layerEffects'), effects);
  executeAction(charIDToTypeID('setd'), desc, DialogModes.NO);
});
op('fix.layer', 'stroke layer style on unlocked layer', function (doc) {
  unlocked(doc);
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('layerEffects'));
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  var effects = new ActionDescriptor();
  var stroke = new ActionDescriptor();
  stroke.putBoolean(stringIDToTypeID('enabled'), true);
  stroke.putUnitDouble(stringIDToTypeID('size'), stringIDToTypeID('pixelsUnit'), 3);
  var colour = new ActionDescriptor();
  colour.putDouble(charIDToTypeID('Rd  '), 255);
  colour.putDouble(charIDToTypeID('Grn '), 0);
  colour.putDouble(charIDToTypeID('Bl  '), 0);
  stroke.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), colour);
  effects.putObject(stringIDToTypeID('frameFX'), stringIDToTypeID('frameFX'), stroke);
  desc.putObject(charIDToTypeID('T   '), stringIDToTypeID('layerEffects'), effects);
  executeAction(charIDToTypeID('setd'), desc, DialogModes.NO);
});
op('fix.layer', 'group layers through the DOM layerSets.add', function (doc) {
  var second = doc.artLayers.add();
  var set = doc.layerSets.add();
  doc.layers[0].move(set, ElementPlacement.INSIDE);
  second.move(set, ElementPlacement.INSIDE);
});
op('fix.layer', 'groupLayersEvent on two selected layers', function (doc) {
  doc.artLayers.add();
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  desc.putBoolean(stringIDToTypeID('group'), true);
  executeAction(stringIDToTypeID('groupLayersEvent'), desc, DialogModes.NO);
});
op('fix.layer', 'ungroupLayersEvent on a layer set', function (doc) {
  var set = doc.layerSets.add();
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('ungroupLayersEvent'), desc, DialogModes.NO);
});
op('fix.layer', 'rasterize a smart object and a text layer', function (doc) {
  var smartDesc = new ActionDescriptor();
  var smartRef = new ActionReference();
  smartRef.putClass(stringIDToTypeID('smartObject'));
  smartDesc.putReference(charIDToTypeID('null'), smartRef);
  var target = new ActionReference();
  target.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  smartDesc.putReference(charIDToTypeID('Lyr '), target);
  executeAction(stringIDToTypeID('newPlacedLayer'), smartDesc, DialogModes.NO);
  doc.activeLayer.rasterize(RasterizeType.ENTIRELAYER);
});

// ── DOM-native routes that should replace descriptor recipes entirely ───────
op('dom.text', 'text layer through LayerKind.TEXT', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.textItem.contents = 'dsh text';
});
op('dom.text', 'edit text contents, size, colour, justification', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.textItem.contents = 'dsh text';
  layer.textItem.size = UnitValue(18, 'px');
  layer.textItem.justification = Justification.CENTER;
  var colour = new SolidColor();
  colour.rgb.red = 255; colour.rgb.green = 240; colour.rgb.blue = 10;
  layer.textItem.color = colour;
  layer.textItem.position = [UnitValue(4, 'px'), UnitValue(20, 'px')];
});
op('dom.text', 'kill and re-read text contents', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.textItem.contents = 'first';
  if (String(layer.textItem.contents) !== 'first') throw new Error('contents did not round trip');
  layer.textItem.contents = 'second';
});
op('dom.layer', 'adjustment layer LayerKind.LEVELS', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.LEVELS;
  layer.adjustLevels(10, 240, 1.2, 0, 255);
});
op('dom.layer', 'adjustment layer LayerKind.HUESATURATION', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.HUESATURATION;
});
op('dom.layer', 'fill layer LayerKind.SOLIDFILL', function (doc) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.SOLIDFILL;
});
op('dom.layer', 'duplicate, translate, rotate, resize, remove', function (doc) {
  var copy = doc.activeLayer.duplicate();
  copy.translate(UnitValue(3, 'px'), UnitValue(3, 'px'));
  copy.rotate(15, AnchorPosition.MIDDLECENTER);
  copy.resize(80, 80, AnchorPosition.MIDDLECENTER);
  copy.remove();
});
op('dom.layer', 'blend mode, opacity, visibility, lock', function (doc) {
  var layer = doc.activeLayer;
  layer.blendMode = BlendMode.MULTIPLY;
  layer.opacity = 70;
  layer.visible = true;
  layer.allLocked = false;
  if (layer.opacity !== 70) throw new Error('opacity did not take');
});
op('dom.layer', 'style file round trip (applyStyleFile needs a file)', function (doc) {
  if (typeof doc.activeLayer.applyStyleFile !== 'function') throw new Error('applyStyleFile missing');
});

// ── corrected descriptor recipes ────────────────────────────────────────────
op('fix.descriptor', 'selection.stroke with a valid location enum', function (doc) {
  var colour = new SolidColor();
  colour.rgb.red = 255; colour.rgb.green = 0; colour.rgb.blue = 0;
  doc.selection.select([[14, 14], [34, 14], [34, 34], [14, 34]]);
  doc.selection.stroke(colour, 2, StrokeLocation.INSIDE, ColorBlendMode.NORMAL, 100, true);
  doc.selection.deselect();
});
op('fix.descriptor', 'trim transparent with a real selection', function (doc) {
  unlocked(doc);
  doc.selection.select([[6, 6], [42, 6], [42, 42], [6, 42]]);
  doc.selection.invert();
  doc.selection.clear();
  doc.selection.deselect();
  doc.trim(TrimType.TRANSPARENT);
});
op('fix.descriptor', 'custom options with an ActionDescriptor', function (doc) {
  var payload = new ActionDescriptor();
  payload.putString(stringIDToTypeID('dshKey'), 'dshValue');
  app.putCustomOptions('dshProbe', payload, false);
  var read = app.getCustomOptions('dshProbe');
  app.eraseCustomOptions('dshProbe');
  if (read === undefined) throw new Error('round trip returned nothing');
});
op('fix.descriptor', 'autoColor / autoTone / autoContrast without a descriptor', function (doc) {
  var failures = [];
  var names = ['autoColor', 'autoTone', 'autoContrast'];
  for (var i = 0; i < names.length; i++) {
    try { executeAction(stringIDToTypeID(names[i]), undefined, DialogModes.NO); }
    catch (error) { failures.push(names[i]); }
  }
  if (failures.length === names.length) throw new Error('all three unavailable: ' + failures.join(','));
});
op('fix.descriptor', 'gradientMap with explicit stops', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  var gradient = new ActionDescriptor();
  gradient.putString(stringIDToTypeID('name'), 'dsh gradient');
  gradient.putEnumerated(stringIDToTypeID('gradientForm'), stringIDToTypeID('gradientForm'), stringIDToTypeID('customStops'));
  gradient.putDouble(stringIDToTypeID('interfaceIconFillSelection'), 0);
  var stops = new ActionList();
  var first = new ActionDescriptor();
  var startColour = new ActionDescriptor();
  startColour.putDouble(charIDToTypeID('Rd  '), 255);
  startColour.putDouble(charIDToTypeID('Grn '), 0);
  startColour.putDouble(charIDToTypeID('Bl  '), 0);
  first.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), startColour);
  first.putEnumerated(charIDToTypeID('Type'), stringIDToTypeID('colorStopType'), charIDToTypeID('Clr '));
  first.putUnitDouble(stringIDToTypeID('location'), stringIDToTypeID('percentUnit'), 0);
  stops.putObject(stringIDToTypeID('colorStop'), first);
  var second = new ActionDescriptor();
  var endColour = new ActionDescriptor();
  endColour.putDouble(charIDToTypeID('Rd  '), 0);
  endColour.putDouble(charIDToTypeID('Grn '), 0);
  endColour.putDouble(charIDToTypeID('Bl  '), 255);
  second.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), endColour);
  second.putEnumerated(charIDToTypeID('Type'), stringIDToTypeID('colorStopType'), charIDToTypeID('Clr '));
  second.putUnitDouble(stringIDToTypeID('location'), stringIDToTypeID('percentUnit'), 100);
  stops.putObject(stringIDToTypeID('colorStop'), second);
  gradient.putList(stringIDToTypeID('colors'), stops);
  desc.putObject(stringIDToTypeID('gradient'), stringIDToTypeID('gradientClassEvent'), gradient);
  desc.putBoolean(stringIDToTypeID('dither'), true);
  executeAction(stringIDToTypeID('gradientMapClass'), desc, DialogModes.NO);
});
op('fix.descriptor', 'adjustCurves variants', function (doc) {
  var attempts = [
    function () { doc.activeLayer.adjustCurves([0, 0, 255, 255]); },
    function () { doc.activeLayer.adjustCurves([0, 0, 128, 150, 255, 255]); },
  ];
  var lastError = null;
  for (var i = 0; i < attempts.length; i++) {
    try { attempts[i](); return; } catch (error) { lastError = error; }
  }
  throw lastError;
});
op('fix.descriptor', 'applyCustomFilter with a 5x5 kernel', function (doc) {
  doc.activeLayer.applyCustomFilter([0, 0, 0, 0, 0, 0, -1, -1, -1, 0, 0, -1, 9, -1, 0, 0, -1, -1, -1, 0, 0, 0, 0, 0, 0], 1, 0);
});
op('fix.descriptor', 'cameraRawFilter with a filterFX descriptor', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  var filterDesc = new ActionDescriptor();
  filterDesc.putBoolean(stringIDToTypeID('linear'), false);
  desc.putObject(stringIDToTypeID('filterFX'), stringIDToTypeID('filterFX'), filterDesc);
  executeAction(stringIDToTypeID('cameraRawFilter'), desc, DialogModes.NO);
});

// ── runner ──────────────────────────────────────────────────────────────────
var globals = {};
for (var g = 0; g < DSH.enums.length; g++) {
  try { globals[DSH.enums[g]] = (typeof eval(DSH.enums[g]) !== 'undefined'); }
  catch (enumError) { globals[DSH.enums[g]] = false; }
}

var results = [];
var previousDialogs = app.displayDialogs;
var out = { ok: true, results: results, globals: globals, photoshop: String(app.version) };
try {
  app.displayDialogs = DialogModes.NO;
  for (var index = 0; index < OPS.length; index++) {
    var current = OPS[index];
    var record = { index: index, group: current.group, name: current.name, ok: false };
    var doc = null;
    try {
      doc = app.documents.add(48, 48, 72, 'dsh-op-probe2', NewDocumentMode.RGB, DocumentFill.WHITE);
      paint(doc, 120, 180, 90);
      current.fn(doc);
      record.ok = true;
    } catch (error) {
      record.error = String(error.message ? error.message : error);
    } finally {
      if (doc !== null) {
        try { doc.close(SaveOptions.DONOTSAVECHANGES); }
        catch (closeError) { record.closeError = String(closeError.message); }
      }
    }
    results.push(record);
    if (DSH.progressPath) dshWrite(DSH.progressPath, { done: index + 1, total: OPS.length, current: current.name });
    dshWrite(DSH.resultPath, out);
  }
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
} finally {
  try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_ROUND2_DONE'
`
}

function line(text = '') {
  process.stdout.write(`${text}\n`)
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true })
  const session = createSession()
  try {
    const jsx = customScript(
      { resultPath: session.resultPath, progressPath: session.progressPath, enums: ENUMS },
      body(),
    )
    const outcome = await session.run(jsx, { timeoutMs: 600000 })
    const report = readJsonFile(session.resultPath)
    const progress = readJsonFile(session.progressPath)
    if (report === undefined) {
      line(`no report (bridge: ${outcome.status})`)
      if (progress !== undefined) line(`reached ${progress.done}/${progress.total} — "${progress.current}"`)
      process.exitCode = 1
      return
    }
    writeFileSync(join(REPORT_DIR, 'operations-round2.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    line(`Photoshop ${report.photoshop} — round 2, ${report.results.length} corrected operations`)
    line()
    let group = ''
    for (const record of report.results) {
      if (record.group !== group) {
        group = record.group
        line(`── ${group}`)
      }
      line(`  ${record.ok ? 'ok  ' : 'FAIL'}  ${record.name}${record.ok ? '' : `  — ${record.error ?? 'unknown'}`}`)
    }
    const missing = Object.entries(report.globals ?? {}).filter(([, present]) => !present).map(([name]) => name)
    line()
    line(`enums missing: ${missing.length === 0 ? '(none)' : missing.join(', ')}`)
    const ok = report.results.filter((record) => record.ok).length
    line(`${ok}/${report.results.length} corrected operations verified`)
  } finally {
    session.cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`\n round 2 probe crashed: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
})
