/**
 * dsh-plugin-photoshop — capability probe.
 *
 * Answers "what can THIS Photoshop actually do?" instead of trusting a
 * reference PDF. It has three layers:
 *
 *   1. Reflection — ExtendScript exposes `.reflect.properties` / `.methods` for
 *      host objects, which is the authoritative API surface of the installed
 *      version. This is what tells us whether a documented member was pruned.
 *   2. Globals and enums — which classes and enumerations the scripting engine
 *      actually defines.
 *   3. ActionManager catalogue — `stringIDToTypeID(name)` resolves the numeric
 *      four-character code for a command; 0 means this version does not know it.
 *
 * A resolved id proves the command *exists*, not that it will run: Photoshop
 * 2026 resolves `selectSubject` (4561) and still refuses to execute it, while
 * `autoCutout` (496) works. Executability is therefore verified per feature by
 * the end-to-end test, never inferred from this probe.
 *
 * Run with:  node test/probe-capabilities.mjs
 * The full report lands in `_research/capabilities.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { customScript } from '../lib/jsx.js'
import { createSession, readJsonFile } from '../lib/ps.js'

const WORKSPACE = join(import.meta.dirname, '..')
const REPORT_DIR = join(WORKSPACE, '_research')

/** ExtendScript classes a recipe might construct. */
const GLOBAL_CLASSES = [
  'Application', 'Document', 'Documents', 'ArtLayer', 'ArtLayers', 'LayerSet', 'LayerSets', 'LayerComp', 'LayerComps',
  'Selection', 'Channel', 'Channels', 'HistoryState', 'HistoryStates', 'ColorSampler', 'ColorSamplers', 'CountItem', 'CountItems',
  'TextItem', 'ParagraphTextItem', 'PathItem', 'PathItems', 'PathPoint', 'PathPointInfo', 'SubPathInfo', 'SubPathItem',
  'SolidColor', 'RGBColor', 'CMYKColor', 'HSBColor', 'LabColor', 'GrayColor', 'NoColor', 'PatternColor', 'GradientColor',
  'UnitValue', 'ActionDescriptor', 'ActionList', 'ActionReference', 'File', 'Folder', 'Notifier', 'Notifiers',
  'PhotoshopSaveOptions', 'PNGSaveOptions', 'JPEGSaveOptions', 'TiffSaveOptions', 'GIFSaveOptions', 'BMPSaveOptions',
  'PDFSaveOptions', 'EPSOpenOptions', 'ExportOptionsSaveForWeb', 'ExportOptionsIllustrator', 'BMPSaveOptions',
  'CameraRAWOpenOptions', 'GalleryOptions', 'ContactSheetOptions', 'PicturePackageOptions', 'PresentationOptions',
]

/** ExtendScript enumerations a recipe might reference. */
const GLOBAL_ENUMS = [
  'DialogModes', 'SaveOptions', 'TrimType', 'ResampleMethod', 'ElementPlacement', 'LayerKind', 'BlendMode', 'Direction',
  'Justification', 'TextType', 'Language', 'AnchorPosition', 'RasterizeType', 'PurgeTarget', 'ChangeMode', 'ChannelType',
  'ColorBlendMode', 'ColorPicker', 'Dither', 'ForcedColors', 'Intent', 'IntersectShape', 'NewDocumentMode', 'DocumentFill',
  'DocumentColorProfile', 'SaveEncoding', 'JPEGColorSpace', 'PNGMethod', 'PNGFilter', 'TIFFEncoding', 'ByteOrder',
  'GalleryConstrain', 'GridSize', 'Geometry', 'GuidePosition', 'MeasurementLogType', 'StopType', 'UndoHistoryState',
  'Extension', 'FontPreviewType', 'NotifierType', 'SaveBehavior', 'QueryStateType',
]

/** ActionManager commands and descriptor keys worth knowing about. */
const ACTION_IDS = [
  // AI / selection
  'autoCutout', 'selectSubject', 'removeBackground', 'selectSky', 'replaceSky', 'selectFocusArea', 'colorRange',
  'selectAndMask', 'refineEdge', 'quickSelect', 'magicWand', 'grow', 'similar', 'feather', 'expand', 'contract',
  'smooth', 'border', 'contentAwareFill', 'contentAwareScale', 'contentAwareMove', 'generativeFill', 'generativeExpand',
  'removeTool', 'spotHealingBrush', 'healingBrush', 'patchTool', 'redEye', 'skyReplace', 'neuralFilters',
  'superResolution', 'denoise', 'rawDenoise', 'selectAll', 'deselect', 'inverse', 'load', 'save', 'duplicate',
  // tonal and colour adjustments
  'autoTone', 'autoContrast', 'autoColor', 'autoLevels', 'brightnessContrast', 'levels', 'curves', 'hueSaturation',
  'vibrance', 'desaturate', 'blackAndWhite', 'photoFilter', 'channelMixer', 'colorBalance', 'selectiveColor',
  'gradientMap', 'invert', 'posterize', 'threshold', 'exposure', 'shadowsHighlights', 'hdrToning', 'matchColor',
  'replaceColor', 'equalize', 'variations', 'colorLookup', 'curvesAdjustment',
  // filters
  'gaussianBlur', 'motionBlur', 'radialBlur', 'boxBlur', 'lensBlur', 'surfaceBlur', 'smartBlur', 'unsharpMask',
  'sharpen', 'sharpenEdges', 'smartSharpen', 'addNoise', 'despeckle', 'dustAndScratches', 'median', 'reduceNoise',
  'oilPaint', 'liquify', 'vanishingPoint', 'cameraRawFilter', 'highPass', 'emboss', 'findEdges', 'glowingEdges',
  'solarize', 'wind', 'ripple', 'wave', 'spherize', 'pinch', 'twirl', 'displace', 'clouds', 'lensFlare', 'lightingEffects',
  // layers
  'newLayer', 'deleteLayer', 'duplicateLayer', 'groupLayers', 'ungroupLayers', 'mergeLayers', 'mergeVisible',
  'flattenImage', 'rasterizeLayer', 'convertToSmartObject', 'newSmartObjectViaCopy', 'layerViaCopy', 'layerViaCut',
  'addLayerMask', 'deleteLayerMask', 'applyLayerMask', 'invertLayerMask', 'createClippingMask', 'releaseClippingMask',
  'dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevelEmboss', 'stroke', 'colorOverlay', 'gradientOverlay',
  'patternOverlay', 'satin', 'align', 'distribute', 'selectAllLayers', 'linkLayers', 'unlinkLayers', 'move',
  'bringToFront', 'sendToBack', 'bringForward', 'sendBackward', 'translate', 'make', 'delete',
  // document
  'newDocument', 'canvasSize', 'imageSize', 'crop', 'trim', 'rotateCanvas', 'flipCanvas', 'duplicateDocument',
  'revealAll', 'close', 'saveAs', 'save', 'export', 'quickExportAs', 'exportAs', 'saveForWeb', 'batch', 'imageProcessor',
  'playAction', 'recordAction', 'setMetadata', 'getMetadata', 'convertMode', 'assignProfile', 'convertProfile',
  // shapes, fills, strokes, text
  'fill', 'stroke', 'gradient', 'newShapeLayer', 'rectangle', 'ellipse', 'polygon', 'line', 'customShape',
  'newTextLayer', 'horizontalTypeTool', 'verticalTypeTool', 'warpText', 'convertToParagraphText', 'convertToPointText',
  'freeTransform', 'transform', 'contentAwareScale', 'puppetWarp', 'perspectiveWarp',
]

/**
 * Build the ExtendScript body of the probe.
 * @returns ExtendScript statements.
 */
function probeBody() {
  return `
var out = { ok: true, reflect: {}, globals: { classes: {}, enums: {} }, actionIds: {}, counts: {} };

function dshNames(collection) {
  var list = [];
  try {
    for (var i = 0; i < collection.length; i++) list.push(String(collection[i]));
  } catch (error) { }
  return list;
}

function dshReflect(label, target) {
  try {
    out.reflect[label] = {
      properties: dshNames(target.reflect.properties),
      methods: dshNames(target.reflect.methods)
    };
  } catch (error) {
    out.reflect[label] = { error: String(error.message ? error.message : error) };
  }
}

var previousDialogs = null;
var createdDocument = false;
var doc = null;
try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  out.photoshop = { version: String(app.version), build: String(app.build) };

  dshReflect('app', app);

  for (var c = 0; c < DSH.classes.length; c++) {
    var className = DSH.classes[c];
    try { out.globals.classes[className] = (typeof eval(className) !== 'undefined'); }
    catch (classError) { out.globals.classes[className] = false; }
  }
  for (var e = 0; e < DSH.enums.length; e++) {
    var enumName = DSH.enums[e];
    try { out.globals.enums[enumName] = (typeof eval(enumName) !== 'undefined'); }
    catch (enumError) { out.globals.enums[enumName] = false; }
  }

  for (var a = 0; a < DSH.actionIds.length; a++) {
    var idName = DSH.actionIds[a];
    try { out.actionIds[idName] = stringIDToTypeID(idName); }
    catch (idError) { out.actionIds[idName] = -1; }
  }

  if (app.documents.length > 0) {
    doc = app.activeDocument;
    out.documentSource = 'existing';
  } else {
    doc = app.documents.add(64, 64, 72, 'dsh-capability-probe', NewDocumentMode.RGB, DocumentFill.WHITE);
    createdDocument = true;
    out.documentSource = 'created';
  }

  dshReflect('document', doc);
  dshReflect('layer', doc.activeLayer);
  dshReflect('selection', doc.selection);
  dshReflect('artLayers', doc.artLayers);
  dshReflect('layerSets', doc.layerSets);
  dshReflect('channels', doc.channels);

  try {
    out.enums = {
      layerKinds: dshNames([LayerKind.NORMAL, LayerKind.TEXT, LayerKind.SMARTOBJECT, LayerKind.SOLIDFILL,
        LayerKind.GRADIENTFILL, LayerKind.PATTERNFILL, LayerKind.LEVELS, LayerKind.CURVES, LayerKind.HUESATURATION,
        LayerKind.BRIGHTNESSCONTRAST, LayerKind.INVERSION, LayerKind.THRESHOLD, LayerKind.POSTERIZE, LayerKind.VIDEO]),
      saveOptions: dshNames([SaveOptions.DONOTSAVECHANGES, SaveOptions.SAVECHANGES, SaveOptions.PROMPTTOSAVECHANGES]),
      blendModeCount: 0
    };
  } catch (enumReadError) { out.enumReadError = String(enumReadError.message); }

  out.counts.documentsOpen = app.documents.length;
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
} finally {
  if (createdDocument && doc !== null) {
    try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { out.closeError = String(closeError.message); }
  }
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_CAPABILITY_PROBE_DONE'
`
}

function line(text = '') {
  process.stdout.write(`${text}\n`)
}

/** Print the names an object exposes, split into a couple of readable columns. */
function showNames(label, names, limit = 400) {
  if (!Array.isArray(names)) return
  line(`  ${label} (${names.length}): ${names.slice(0, limit).join(', ')}${names.length > limit ? `, …+${names.length - limit}` : ''}`)
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true })
  const session = createSession()
  try {
    const jsx = customScript(
      {
        resultPath: session.resultPath,
        classes: GLOBAL_CLASSES,
        enums: GLOBAL_ENUMS,
        actionIds: ACTION_IDS,
      },
      probeBody(),
    )
    const outcome = await session.run(jsx, { timeoutMs: 300000 })
    const report = readJsonFile(session.resultPath)
    if (report === undefined) {
      line(`probe produced no report (bridge status: ${outcome.status})`)
      process.exitCode = 1
      return
    }
    const reportPath = join(REPORT_DIR, 'capabilities.json')
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    line(`Photoshop ${report.photoshop?.version} (build ${report.photoshop?.build})`)
    line(`document used for reflecting: ${report.documentSource}`)
    line()
    line('── reflection ───────────────────────────────────────────────')
    for (const [label, entry] of Object.entries(report.reflect ?? {})) {
      if (entry.error !== undefined) {
        line(`  ${label}: no reflection available (${entry.error})`)
        continue
      }
      line(`  ${label}: ${entry.properties.length} properties, ${entry.methods.length} methods`)
      showNames('properties', entry.properties)
      showNames('methods', entry.methods)
    }
    line()
    line('── globals ──────────────────────────────────────────────────')
    const missingClasses = Object.entries(report.globals?.classes ?? {}).filter(([, present]) => !present).map(([n]) => n)
    const missingEnums = Object.entries(report.globals?.enums ?? {}).filter(([, present]) => !present).map(([n]) => n)
    line(`  classes present: ${Object.values(report.globals?.classes ?? {}).filter(Boolean).length}/${GLOBAL_CLASSES.length}`)
    if (missingClasses.length > 0) line(`  classes MISSING: ${missingClasses.join(', ')}`)
    line(`  enums  present: ${Object.values(report.globals?.enums ?? {}).filter(Boolean).length}/${GLOBAL_ENUMS.length}`)
    if (missingEnums.length > 0) line(`  enums  MISSING: ${missingEnums.join(', ')}`)
    line()
    line('── ActionManager catalogue ──────────────────────────────────')
    const ids = report.actionIds ?? {}
    const resolved = Object.entries(ids).filter(([, id]) => id > 0).map(([n]) => n)
    const unresolved = Object.entries(ids).filter(([, id]) => id <= 0).map(([n]) => n)
    line(`  resolved: ${resolved.length}/${Object.keys(ids).length}`)
    line(`  UNRESOLVED: ${unresolved.join(', ')}`)
    line()
    line(`full report: ${reportPath}`)
  } finally {
    session.cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`\n capability probe crashed: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
})
