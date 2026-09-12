/**
 * dsh-plugin-photoshop — operation verification matrix.
 *
 * The capability probe established two things the hard way: reflection tells us
 * exactly which DOM members exist, but a resolved ActionManager id proves
 * nothing about whether the command will run (Photoshop 2026 resolves
 * `selectSubject` and then refuses to execute it). So every candidate operation
 * in this file is *attempted for real*, each on its own scratch document, and
 * the result is a matrix of what this installation can actually do.
 *
 * The matrix is the evidence behind the roadmap: an operation earns a place in
 * the plugin's vocabulary only when it appears here as `ok`.
 *
 * Run with:  node test/probe-operations.mjs
 * The matrix lands in `_research/operations.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { customScript } from '../lib/jsx.js'
import { createSession, readJsonFile } from '../lib/ps.js'

const WORKSPACE = join(import.meta.dirname, '..')
const REPORT_DIR = join(WORKSPACE, '_research')

/**
 * The ExtendScript body: one registration per candidate operation, then a runner
 * that gives each its own scratch document so a failure cannot contaminate the
 * next attempt. Results are flushed after every operation, so a hang still
 * yields everything that had already run.
 * @returns ExtendScript statements.
 */
function operationsBody() {
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

// ── AI selection commands ───────────────────────────────────────────────────
op('selection.ai', 'autoCutout (Select Subject)', function (doc) {
  executeAction(stringIDToTypeID('autoCutout'), new ActionDescriptor(), DialogModes.NO);
});
op('selection.ai', 'removeBackground', function (doc) {
  executeAction(stringIDToTypeID('removeBackground'), new ActionDescriptor(), DialogModes.NO);
});
op('selection.ai', 'selectSky', function (doc) {
  executeAction(stringIDToTypeID('selectSky'), new ActionDescriptor(), DialogModes.NO);
});
op('selection.ai', 'selectFocusArea', function (doc) {
  executeAction(stringIDToTypeID('selectFocusArea'), new ActionDescriptor(), DialogModes.NO);
});
op('selection.ai', 'generativeFill', function (doc) {
  doc.selection.select([[8, 8], [40, 8], [40, 40], [8, 40]]);
  executeAction(stringIDToTypeID('generativeFill'), new ActionDescriptor(), DialogModes.NO);
});
op('selection.ai', 'contentAwareFill', function (doc) {
  doc.selection.select([[8, 8], [40, 8], [40, 40], [8, 40]]);
  executeAction(stringIDToTypeID('contentAwareFill'), new ActionDescriptor(), DialogModes.NO);
});

// ── selection through descriptors ───────────────────────────────────────────
op('selection.am', 'colorRange', function (doc) {
  var desc = new ActionDescriptor();
  desc.putInteger(stringIDToTypeID('fuzziness'), 40);
  var ref = new ActionReference();
  ref.putProperty(charIDToTypeID('Chnl'), charIDToTypeID('fsel'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('colorRange'), desc, DialogModes.NO);
});
op('selection.am', 'border', function (doc) {
  doc.selection.selectAll();
  doc.selection.selectBorder(4);
});
op('selection.dom', 'store and load channel', function (doc) {
  doc.selection.selectAll();
  doc.selection.store(doc.channels.add());
  doc.selection.deselect();
  doc.selection.load(doc.channels[doc.channels.length - 1]);
});
op('selection.dom', 'makeWorkPath', function (doc) {
  doc.selection.selectAll();
  doc.selection.makeWorkPath(2);
});

// ── layer masks and styles through descriptors ──────────────────────────────
op('layer.am', 'add reveal-all layer mask', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('channel'));
  desc.putReference(charIDToTypeID('null'), ref);
  desc.putClass(stringIDToTypeID('at'), stringIDToTypeID('mask'));
  var using = new ActionReference();
  using.putEnumerated(stringIDToTypeID('channel'), stringIDToTypeID('channel'), stringIDToTypeID('mask'));
  desc.putReference(stringIDToTypeID('using'), using);
  executeAction(stringIDToTypeID('make'), desc, DialogModes.NO);
});
op('layer.am', 'delete layer mask', function (doc) {
  var makeDesc = new ActionDescriptor();
  var makeRef = new ActionReference();
  makeRef.putClass(stringIDToTypeID('channel'));
  makeDesc.putReference(charIDToTypeID('null'), makeRef);
  makeDesc.putClass(stringIDToTypeID('at'), stringIDToTypeID('mask'));
  executeAction(stringIDToTypeID('make'), makeDesc, DialogModes.NO);

  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), stringIDToTypeID('mask'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(charIDToTypeID('Dlt '), desc, DialogModes.NO);
});
op('layer.am', 'invert layer mask', function (doc) {
  var makeDesc = new ActionDescriptor();
  var makeRef = new ActionReference();
  makeRef.putClass(stringIDToTypeID('channel'));
  makeDesc.putReference(charIDToTypeID('null'), makeRef);
  makeDesc.putClass(stringIDToTypeID('at'), stringIDToTypeID('mask'));
  executeAction(stringIDToTypeID('make'), makeDesc, DialogModes.NO);

  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), stringIDToTypeID('mask'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('inverse'), desc, DialogModes.NO);
});
op('layer.am', 'clipping mask', function (doc) {
  doc.artLayers.add();
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  desc.putBoolean(stringIDToTypeID('group'), true);
  executeAction(stringIDToTypeID('groupEvent'), desc, DialogModes.NO);
});
op('layer.am', 'drop shadow layer style', function (doc) {
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
op('layer.am', 'stroke layer style', function (doc) {
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
op('layer.am', 'group and ungroup layers', function (doc) {
  doc.artLayers.add();
  var groupDesc = new ActionDescriptor();
  var groupRef = new ActionReference();
  groupRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  groupDesc.putReference(charIDToTypeID('null'), groupRef);
  executeAction(stringIDToTypeID('groupLayers'), groupDesc, DialogModes.NO);
  var ungroupDesc = new ActionDescriptor();
  var ungroupRef = new ActionReference();
  ungroupRef.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  ungroupDesc.putReference(charIDToTypeID('null'), ungroupRef);
  executeAction(stringIDToTypeID('ungroupLayers'), ungroupDesc, DialogModes.NO);
});

// ── smart objects and rasterising ───────────────────────────────────────────
op('layer.am', 'convert to smart object', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('smartObject'));
  desc.putReference(charIDToTypeID('null'), ref);
  var target = new ActionReference();
  target.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('Lyr '), target);
  executeAction(stringIDToTypeID('newPlacedLayer'), desc, DialogModes.NO);
});
op('layer.dom', 'rasterize', function (doc) {
  doc.activeLayer.rasterize(RasterizeType.ENTIRELAYER);
});

// ── text ────────────────────────────────────────────────────────────────────
op('text.am', 'new point text layer', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('textLayer'));
  desc.putReference(charIDToTypeID('null'), ref);
  var contents = new ActionDescriptor();
  contents.putString(charIDToTypeID('Txt '), 'dsh probe');
  desc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('textLayer'), contents);
  executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
});
op('text.dom', 'edit text contents and size', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('textLayer'));
  desc.putReference(charIDToTypeID('null'), ref);
  var contents = new ActionDescriptor();
  contents.putString(charIDToTypeID('Txt '), 'dsh probe');
  desc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('textLayer'), contents);
  executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
  doc.activeLayer.textItem.contents = 'edited by dsh';
  doc.activeLayer.textItem.size = UnitValue(14, 'px');
});
op('text.am', 'warp text', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('textLayer'));
  desc.putReference(charIDToTypeID('null'), ref);
  var contents = new ActionDescriptor();
  contents.putString(charIDToTypeID('Txt '), 'warp');
  desc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('textLayer'), contents);
  executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
  var warp = new ActionDescriptor();
  warp.putEnumerated(stringIDToTypeID('warpStyle'), stringIDToTypeID('warpStyle'), stringIDToTypeID('warpArc'));
  warp.putUnitDouble(stringIDToTypeID('warpValue'), stringIDToTypeID('percentUnit'), 40);
  var target = new ActionReference();
  target.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  var setDesc = new ActionDescriptor();
  setDesc.putReference(charIDToTypeID('null'), target);
  setDesc.putObject(charIDToTypeID('T   '), stringIDToTypeID('textWarps'), warp);
  executeAction(charIDToTypeID('setd'), setDesc, DialogModes.NO);
});

// ── shapes ──────────────────────────────────────────────────────────────────
op('shape.am', 'rectangle shape layer', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putClass(stringIDToTypeID('contentLayer'));
  desc.putReference(charIDToTypeID('null'), ref);
  var shape = new ActionDescriptor();
  shape.putUnitDouble(stringIDToTypeID('top'), stringIDToTypeID('pixelsUnit'), 6);
  shape.putUnitDouble(stringIDToTypeID('left'), stringIDToTypeID('pixelsUnit'), 6);
  shape.putUnitDouble(stringIDToTypeID('bottom'), stringIDToTypeID('pixelsUnit'), 34);
  shape.putUnitDouble(stringIDToTypeID('right'), stringIDToTypeID('pixelsUnit'), 34);
  var colour = new ActionDescriptor();
  colour.putDouble(charIDToTypeID('Rd  '), 20);
  colour.putDouble(charIDToTypeID('Grn '), 120);
  colour.putDouble(charIDToTypeID('Bl  '), 220);
  shape.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), colour);
  desc.putObject(charIDToTypeID('Usng'), stringIDToTypeID('rectangle'), shape);
  executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
});
op('shape.dom', 'selection fill and stroke', function (doc) {
  var colour = new SolidColor();
  colour.rgb.red = 10; colour.rgb.green = 10; colour.rgb.blue = 10;
  doc.selection.select([[10, 10], [38, 10], [38, 38], [10, 38]]);
  doc.selection.fill(colour);
  doc.selection.stroke(colour, 2, StrokeLocation.INSIDE, ColorBlendMode.NORMAL, 100, true);
  doc.selection.deselect();
});

// ── document operations ─────────────────────────────────────────────────────
op('document.dom', 'suspendHistory', function (doc) {
  doc.suspendHistory('dsh grouped step', 'app.activeDocument.activeLayer.opacity = 80;');
});
op('document.dom', 'crop', function (doc) {
  doc.crop([UnitValue(4, 'px'), UnitValue(4, 'px'), UnitValue(32, 'px'), UnitValue(32, 'px')]);
});
op('document.dom', 'resizeCanvas', function (doc) {
  doc.resizeCanvas(UnitValue(64, 'px'), UnitValue(64, 'px'), AnchorPosition.MIDDLECENTER);
});
op('document.dom', 'changeMode grayscale', function (doc) {
  doc.changeMode(ChangeMode.GRAYSCALE);
});
op('document.dom', 'convertProfile', function (doc) {
  doc.convertProfile('sRGB IEC61966-2.1', Intent.RELATIVECOLORIMETRIC, true, true);
});
op('document.dom', 'trim transparent', function (doc) {
  var background = doc.layers[0];
  if (background.isBackgroundLayer) background.isBackgroundLayer = false;
  doc.selection.select([[0, 0], [10, 10], [10, 10], [0, 0]]);
  doc.selection.invert();
  doc.selection.clear();
  doc.selection.deselect();
  doc.trim(TrimType.TRANSPARENT);
});
op('document.dom', 'flatten and mergeVisible', function (doc) {
  doc.artLayers.add();
  doc.mergeVisibleLayers();
});
op('document.dom', 'xmpMetadata read and write', function (doc) {
  var before = String(doc.xmpMetadata.rawData).length;
  doc.xmpMetadata.rawData = doc.xmpMetadata.rawData;
  if (before < 0) throw new Error('unreachable');
});
op('document.am', 'autocount', function (doc) {
  doc.autoCount(10, 10, 20, 20);
});
op('app.dom', 'featureEnabled', function (doc) {
  if (typeof app.featureEnabled !== 'function') throw new Error('featureEnabled missing');
  var value = app.featureEnabled('photoshop.generativeFill');
  if (value === undefined) throw new Error('featureEnabled returned undefined');
});
op('app.dom', 'custom options round trip', function (doc) {
  app.putCustomOptions('dshProbe', 'probe', true);
  var read = app.getCustomOptions('dshProbe');
  app.eraseCustomOptions('dshProbe');
  if (read === undefined) throw new Error('custom options round trip failed');
});

// ── adjustment commands (descriptor form) ───────────────────────────────────
op('adjust.am', 'hueSaturation', function (doc) {
  var desc = new ActionDescriptor();
  desc.putEnumerated(stringIDToTypeID('presetKind'), stringIDToTypeID('presetKindType'), stringIDToTypeID('presetKindCustom'));
  desc.putUnitDouble(stringIDToTypeID('hue'), stringIDToTypeID('angleUnit'), 40);
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('hueSaturation'), desc, DialogModes.NO);
});
op('adjust.am', 'vibrance', function (doc) {
  var desc = new ActionDescriptor();
  desc.putUnitDouble(stringIDToTypeID('vibrance'), stringIDToTypeID('percentUnit'), 30);
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('vibrance'), desc, DialogModes.NO);
});
op('adjust.am', 'blackAndWhite', function (doc) {
  var desc = new ActionDescriptor();
  desc.putEnumerated(stringIDToTypeID('presetKind'), stringIDToTypeID('presetKindType'), stringIDToTypeID('presetKindDefault'));
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('blackAndWhite'), desc, DialogModes.NO);
});
op('adjust.am', 'autoColor', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('autoColor'), desc, DialogModes.NO);
});
op('adjust.am', 'gradientMap', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  var gradient = new ActionDescriptor();
  gradient.putString(stringIDToTypeID('name'), 'dsh');
  gradient.putEnumerated(stringIDToTypeID('gradientForm'), stringIDToTypeID('gradientForm'), stringIDToTypeID('customStops'));
  gradient.putDouble(stringIDToTypeID('interfaceIconFillSelection'), 0);
  desc.putObject(stringIDToTypeID('gradient'), stringIDToTypeID('gradientClassEvent'), gradient);
  desc.putBoolean(stringIDToTypeID('dither'), true);
  executeAction(stringIDToTypeID('gradientMapClass'), desc, DialogModes.NO);
});
op('adjust.dom', 'layer.adjustLevels', function (doc) {
  doc.activeLayer.adjustLevels(0, 255, 1.1, 0, 255);
});
op('adjust.dom', 'layer.adjustCurves', function (doc) {
  doc.activeLayer.adjustCurves([0, 0, 128, 140, 255, 255]);
});

// ── filters (DOM signatures) ────────────────────────────────────────────────
op('filter.dom', 'applyUnSharpMask', function (doc) {
  doc.activeLayer.applyUnSharpMask(80, 2, 3);
});
op('filter.dom', 'applyGaussianBlur', function (doc) {
  doc.activeLayer.applyGaussianBlur(2.5);
});
op('filter.dom', 'applyMotionBlur', function (doc) {
  doc.activeLayer.applyMotionBlur(30, 12);
});
op('filter.dom', 'applyRadialBlur', function (doc) {
  doc.activeLayer.applyRadialBlur(12, RadialBlurMethod.SPIN, RadialBlurQuality.GOOD);
});
op('filter.dom', 'applyCustomFilter', function (doc) {
  doc.activeLayer.applyCustomFilter([0, -1, 0, -1, 5, -1, 0, -1, 0], 1, 0);
});
op('filter.dom', 'applyPinch and applySpherize', function (doc) {
  doc.activeLayer.applyPinch(20);
  doc.activeLayer.applySpherize(20, SpherizeMode.NORMAL);
});
op('filter.am', 'cameraRawFilter', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('cameraRawFilter'), desc, DialogModes.NO);
});
op('filter.am', 'neuralFilters', function (doc) {
  var desc = new ActionDescriptor();
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
  desc.putReference(charIDToTypeID('null'), ref);
  executeAction(stringIDToTypeID('neuralFilters'), desc, DialogModes.NO);
});

// ── saving ──────────────────────────────────────────────────────────────────
op('save.dom', 'saveAs PNG', function (doc) {
  var target = new File(DSH.outputDir + '/probe-save.png');
  if (target.exists) target.remove();
  doc.saveAs(target, new PNGSaveOptions(), true, Extension.LOWERCASE);
  if (!target.exists) throw new Error('no file written');
});
op('save.dom', 'saveAs JPEG', function (doc) {
  var target = new File(DSH.outputDir + '/probe-save.jpg');
  if (target.exists) target.remove();
  var options = new JPEGSaveOptions();
  options.quality = 10;
  doc.saveAs(target, options, true, Extension.LOWERCASE);
  if (!target.exists) throw new Error('no file written');
});
op('save.dom', 'saveAs PSD', function (doc) {
  var target = new File(DSH.outputDir + '/probe-save.psd');
  if (target.exists) target.remove();
  doc.saveAs(target, new PhotoshopSaveOptions(), true, Extension.LOWERCASE);
  if (!target.exists) throw new Error('no file written');
});
op('save.dom', 'exportDocument SaveForWeb', function (doc) {
  var target = new File(DSH.outputDir + '/probe-export.png');
  if (target.exists) target.remove();
  var options = new ExportOptionsSaveForWeb();
  options.format = SaveDocumentType.PNG;
  options.PNG8 = false;
  doc.exportDocument(target, ExportType.SAVEFORWEB, options);
  if (!target.exists) throw new Error('no file written');
});
op('save.dom', 'duplicate document', function (doc) {
  var copy = doc.duplicate('dsh probe copy', false);
  try { copy.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { }
});

// ── history ─────────────────────────────────────────────────────────────────
op('history.dom', 'step backward and forward', function (doc) {
  paint(doc, 200, 30, 30);
  var history = doc.historyStates;
  if (history.length < 2) throw new Error('no history to move through');
  doc.activeHistoryState = history[history.length - 2];
  doc.activeHistoryState = history[history.length - 1];
});

// ── runner ──────────────────────────────────────────────────────────────────
var results = [];
var previousDialogs = app.displayDialogs;
var out = { ok: true, results: results, photoshop: String(app.version) };
try {
  app.displayDialogs = DialogModes.NO;
  for (var index = 0; index < OPS.length; index++) {
    var current = OPS[index];
    var record = { index: index, group: current.group, name: current.name, ok: false };
    var doc = null;
    try {
      doc = app.documents.add(48, 48, 72, 'dsh-op-probe', NewDocumentMode.RGB, DocumentFill.WHITE);
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
'PHOTOSHOP_OPERATION_PROBE_DONE'
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
      {
        resultPath: session.resultPath,
        progressPath: session.progressPath,
        outputDir: session.dir.replace(/\\/g, '/'),
      },
      operationsBody(),
    )
    const outcome = await session.run(jsx, { timeoutMs: 900000 })
    const report = readJsonFile(session.resultPath)
    const progress = readJsonFile(session.progressPath)
    if (report === undefined) {
      line(`no matrix produced (bridge status: ${outcome.status})`)
      if (progress !== undefined) line(`reached: ${progress.done}/${progress.total} — stuck around "${progress.current}"`)
      process.exitCode = 1
      return
    }
    const results = report.results ?? []
    writeFileSync(join(REPORT_DIR, 'operations.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    line(`Photoshop ${report.photoshop} — ${results.length} operations attempted`)
    if (progress !== undefined && progress.done < progress.total) {
      line(`stopped early at ${progress.done}/${progress.total} ("${progress.current}")`)
    }
    line()
    let group = ''
    for (const record of results) {
      if (record.group !== group) {
        group = record.group
        line(`── ${group}`)
      }
      line(`  ${record.ok ? 'ok  ' : 'FAIL'}  ${record.name}${record.ok ? '' : `  — ${record.error ?? 'unknown'}`}`)
    }
    const ok = results.filter((record) => record.ok).length
    line()
    line(`${ok}/${results.length} operations verified on this installation`)
  } finally {
    session.cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`\n operation probe crashed: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
})
