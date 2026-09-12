/**
 * dsh-plugin-photoshop — ExtendScript recipes.
 *
 * Each function returns a complete ExtendScript (ES3) program that Photoshop
 * runs through the COM bridge. The generated program:
 *
 *   1. embeds its parameters as a JSON object literal (`var DSH = {...}`),
 *      which is valid ES3 because JSON is a subset of JavaScript literals —
 *      that is why no escaping layer or base64 hop is needed;
 *   2. saves `app.displayDialogs`, forces `DialogModes.NO` (a modal alert would
 *      otherwise block the COM call forever), and restores it in `finally` so
 *      the user's Photoshop preferences are left exactly as they were;
 *   3. writes its result as JSON through ExtendScript's own file API, because
 *      ExtendScript has no `JSON` object and console encoding cannot be trusted;
 *   4. closes only the documents it opened itself, always without saving.
 *
 * ExtendScript is ES3: no `let`/`const`, no arrow functions, no `JSON`, no
 * `Array.isArray`. `try/catch/finally` and `instanceof Array` are available.
 */

/**
 * Encode a JavaScript value as an ES3-safe object literal.
 * @param value - the parameters to embed.
 * @returns source text for a JavaScript expression.
 */
function toLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c')
}

/**
 * The helpers every recipe shares: a JSON encoder, the file writer, the cancel
 * poller, and the small Photoshop primitives the cutout relies on.
 * Exported so probing and future recipes reuse exactly the same harness.
 * @param params - the recipe parameters, embedded verbatim.
 * @returns ExtendScript source.
 */
export function prelude(params) {
  return `var DSH = ${toLiteral(params)};

function dshEsc(value) {
  var text = String(value);
  var out = '"';
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var code = text.charCodeAt(i);
    if (ch === '"') out += '\\\\"';
    else if (ch === '\\\\') out += '\\\\\\\\';
    else if (code === 8) out += '\\\\b';
    else if (code === 9) out += '\\\\t';
    else if (code === 10) out += '\\\\n';
    else if (code === 12) out += '\\\\f';
    else if (code === 13) out += '\\\\r';
    else if (code < 32 || code > 126) out += '\\\\u' + ('0000' + code.toString(16)).slice(-4);
    else out += ch;
  }
  return out + '"';
}

function dshJson(value, depth) {
  if (depth === undefined) depth = 0;
  if (value === null || value === undefined) return 'null';
  var kind = typeof value;
  if (kind === 'number') return isFinite(value) ? String(value) : 'null';
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'string') return dshEsc(value);
  if (depth > 12) return 'null';
  if (value instanceof Array) {
    var items = [];
    for (var i = 0; i < value.length; i++) items.push(dshJson(value[i], depth + 1));
    return '[' + items.join(',') + ']';
  }
  if (kind === 'object') {
    var keys = [];
    for (var key in value) { if (value.hasOwnProperty(key)) keys.push(key); }
    var pairs = [];
    for (var j = 0; j < keys.length; j++) pairs.push(dshEsc(keys[j]) + ':' + dshJson(value[keys[j]], depth + 1));
    return '{' + pairs.join(',') + '}';
  }
  return dshEsc(String(value));
}

function dshWrite(path, value) {
  var file = new File(path);
  file.encoding = 'UTF-8';
  file.open('w');
  file.write(dshJson(value));
  file.close();
}

function dshCancelled() {
  if (!DSH.cancelPath) return false;
  try { return (new File(DSH.cancelPath)).exists; } catch (error) { return false; }
}

function dshSelectionBounds(doc) {
  try {
    var bounds = doc.selection.bounds;
    return [
      Math.round(bounds[0].value), Math.round(bounds[1].value),
      Math.round(bounds[2].value), Math.round(bounds[3].value)
    ];
  } catch (error) {
    return null;
  }
}

function dshUnlockBackground(doc) {
  try {
    var layer = doc.activeLayer;
    if (layer && layer.isBackgroundLayer) layer.isBackgroundLayer = false;
  } catch (error) { }
}
`
}

/**
 * Report the Photoshop installation, its state, and which recipes this version
 * can actually run. Read-only: it opens nothing and changes nothing except
 * `displayDialogs`, which it restores.
 * @param params - must carry `resultPath`.
 * @returns ExtendScript source.
 */
export function statusScript(params) {
  return `${prelude(params)}
var out = { ok: true, tool: 'photoshop_status' };
var previousDialogs = null;
try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  out.photoshop = {
    name: String(app.name),
    version: String(app.version),
    build: String(app.build),
    engine: String($.engineName) + ' ' + String($.version),
    platform: String($.os)
  };

  out.documentsOpen = app.documents.length;
  out.openDocuments = [];
  for (var i = 0; i < app.documents.length; i++) {
    try { out.openDocuments.push(String(app.documents[i].name)); }
    catch (readError) { out.openDocuments.push('(unreadable)'); }
  }

  out.capabilities = {
    selectSubject: stringIDToTypeID('autoCutout') !== 0,
    removeBackground: stringIDToTypeID('removeBackground') !== 0,
    trimTransparent: true,
    savePngWithAlpha: true
  };
  out.recipes = ['photoshop_cutout', 'photoshop_run_jsx'];
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
} finally {
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_STATUS_DONE'
`
}

/**
 * Cut the subject out of every image in one batch, inside a single Photoshop
 * session — one COM round trip for the whole list rather than one per image.
 *
 * `select-subject` runs Photoshop's Select Subject, then unlocks the background
 * layer, inverts the selection and clears it, which yields real transparency.
 * `remove-background` runs Photoshop's Remove Background instead and keeps its
 * own mask. Both are followed by the optional trim, resize and PNG export.
 *
 * Progress and partial results are written after every image so a timeout or a
 * cancellation still reports what was actually produced.
 * @param params - pairs, mode, trim, featherPx, maxSide, and the output paths.
 * @returns ExtendScript source.
 */
export function cutoutScript(params) {
  return `${prelude(params)}
var out = { ok: true, tool: 'photoshop_cutout', mode: DSH.mode, results: [], cancelled: false };
var previousDialogs = null;

function dshCutoutOne(item, index) {
  var record = { index: index, input: item.input, output: item.output, ok: false };
  var doc = null;
  var dialogs = app.displayDialogs;
  try {
    var source = new File(item.input);
    if (!source.exists) { record.error = 'input file not found'; return record; }
    doc = app.open(source);
    record.sourceWidth = Math.round(doc.width.value);
    record.sourceHeight = Math.round(doc.height.value);

    if (DSH.mode === 'remove-background') {
      executeAction(stringIDToTypeID('removeBackground'), new ActionDescriptor(), DialogModes.NO);
      dshUnlockBackground(doc);
      record.method = 'remove-background';
    } else {
      executeAction(stringIDToTypeID('autoCutout'), new ActionDescriptor(), DialogModes.NO);
      var bounds = dshSelectionBounds(doc);
      if (bounds === null) throw new Error('Select Subject found no subject in this image');
      record.subjectBounds = bounds;
      var width = Math.round(doc.width.value);
      var height = Math.round(doc.height.value);
      if (bounds[0] <= 0 && bounds[1] <= 0 && bounds[2] >= width && bounds[3] >= height) {
        record.warning = 'the subject selection covered the whole frame, so nothing was cut away';
      }
      if (DSH.featherPx > 0) {
        try { doc.selection.feather(DSH.featherPx); }
        catch (featherError) { record.featherWarning = String(featherError.message); }
      }
      dshUnlockBackground(doc);
      doc.selection.invert();
      doc.selection.clear();
      try { doc.selection.deselect(); } catch (deselectError) { }
      record.method = 'select-subject';
    }

    if (DSH.trim === true) {
      try { doc.trim(TrimType.TRANSPARENT); }
      catch (trimError) { record.trimWarning = String(trimError.message); }
    }

    if (DSH.maxSide > 0) {
      var currentWidth = doc.width.value;
      var currentHeight = doc.height.value;
      var longest = currentWidth > currentHeight ? currentWidth : currentHeight;
      if (longest > DSH.maxSide) {
        var scale = DSH.maxSide / longest;
        doc.resizeImage(
          UnitValue(Math.round(currentWidth * scale), 'px'),
          UnitValue(Math.round(currentHeight * scale), 'px'),
          doc.resolution,
          ResampleMethod.BICUBIC
        );
      }
    }
    record.width = Math.round(doc.width.value);
    record.height = Math.round(doc.height.value);

    var target = new File(item.output);
    if (target.exists) target.remove();
    var pngOptions = new PNGSaveOptions();
    pngOptions.compression = 6;
    doc.saveAs(target, pngOptions, true, Extension.LOWERCASE);
    if (!target.exists) throw new Error('Photoshop reported success but wrote no output file');
    record.outputBytes = target.length;
    record.ok = true;
  } catch (error) {
    record.error = String(error.message ? error.message : error);
  } finally {
    try { app.displayDialogs = dialogs; } catch (restoreError) { }
    if (doc !== null) {
      try { doc.close(SaveOptions.DONOTSAVECHANGES); }
      catch (closeError) { record.closeWarning = String(closeError.message); }
    }
  }
  return record;
}

try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;
  var total = DSH.pairs.length;
  for (var index = 0; index < total; index++) {
    if (dshCancelled()) { out.cancelled = true; break; }
    var record = dshCutoutOne(DSH.pairs[index], index);
    out.results.push(record);
    if (DSH.progressPath) {
      dshWrite(DSH.progressPath, { done: index + 1, total: total, current: record.input, ok: record.ok });
    }
    dshWrite(DSH.resultPath, out);
  }
  out.total = out.results.length;
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
} finally {
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_CUTOUT_DONE'
`
}

/**
 * Read everything an agent needs to reason about what is currently on screen:
 * the open documents, one document's dimensions and mode, its selection and
 * history position, and the whole layer tree with the facts that decide what
 * can be done to each layer.
 *
 * Reflection established that `ArtLayer` exposes no `layerMask`-style property,
 * so mask and layer-effect presence comes from an `executeActionGet` lookup by
 * layer id — a reference built from the id never changes the active layer, which
 * is what makes this inspection genuinely read-only.
 *
 * Layer paths are reported twice on purpose: an index path (`0.1`, stable within
 * one inspection and usable by later operations) and a name path (`Header/Title`,
 * what the user says out loud).
 * @param params - `resultPath`, optional `documentName`, `maxLayers`.
 * @returns ExtendScript source.
 */
export function inspectScript(params) {
  return `${prelude(params)}
var out = { ok: true, tool: 'photoshop_inspect' };

function dshEnumTable(expressions) {
  var table = [];
  for (var i = 0; i < expressions.length; i++) {
    try {
      var value = eval(expressions[i]);
      if (value !== undefined && value !== null) table.push([expressions[i].split('.').pop(), value]);
    } catch (error) { }
  }
  return table;
}

function dshNameOf(table, value) {
  for (var i = 0; i < table.length; i++) {
    if (table[i][1] === value) return table[i][0];
  }
  return null;
}

var LAYER_KINDS = dshEnumTable(['LayerKind.NORMAL', 'LayerKind.TEXT', 'LayerKind.SMARTOBJECT',
  'LayerKind.SOLIDFILL', 'LayerKind.GRADIENTFILL', 'LayerKind.PATTERNFILL', 'LayerKind.LEVELS',
  'LayerKind.CURVES', 'LayerKind.HUESATURATION', 'LayerKind.BRIGHTNESSCONTRAST', 'LayerKind.INVERSION',
  'LayerKind.THRESHOLD', 'LayerKind.POSTERIZE', 'LayerKind.VIDEO', 'LayerKind.COLORBALANCE',
  'LayerKind.CHANNELMIXER', 'LayerKind.GRADIENTMAP', 'LayerKind.SELECTIVECOLOR', 'LayerKind.PHOTOFILTER',
  'LayerKind.EXPOSURE', 'LayerKind.BLACKANDWHITE', 'LayerKind.VIBRANCE', 'LayerKind.COLORLOOKUP']);

var BLEND_MODES = dshEnumTable(['BlendMode.NORMAL', 'BlendMode.DISSOLVE', 'BlendMode.DARKEN',
  'BlendMode.MULTIPLY', 'BlendMode.COLORBURN', 'BlendMode.LINEARBURN', 'BlendMode.LIGHTEN',
  'BlendMode.SCREEN', 'BlendMode.COLORDODGE', 'BlendMode.LINEARDODGE', 'BlendMode.OVERLAY',
  'BlendMode.SOFTLIGHT', 'BlendMode.HARDLIGHT', 'BlendMode.VIVIDLIGHT', 'BlendMode.LINEARLIGHT',
  'BlendMode.PINLIGHT', 'BlendMode.HARDMIX', 'BlendMode.DIFFERENCE', 'BlendMode.EXCLUSION',
  'BlendMode.SUBTRACT', 'BlendMode.DIVIDE', 'BlendMode.HUE', 'BlendMode.SATURATION',
  'BlendMode.COLOR', 'BlendMode.LUMINOSITY', 'BlendMode.DARKERCOLOR', 'BlendMode.LIGHTERCOLOR',
  'BlendMode.PASSTHROUGH']);

// Bits per channel is an enumeration, not a number; stringifying it yields
// "[object Object]", so map it explicitly.
function dshBitsName(value) {
  var pairs = [['8', 'BitsPerChannelType.EIGHT'], ['16', 'BitsPerChannelType.SIXTEEN'],
    ['32', 'BitsPerChannelType.THIRTYTWO']];
  for (var i = 0; i < pairs.length; i++) {
    try { if (eval(pairs[i][1]) === value) return pairs[i][0]; } catch (error) { }
  }
  return String(value);
}

var DOCUMENT_MODES = dshEnumTable(['DocumentMode.RGB', 'DocumentMode.GRAYSCALE', 'DocumentMode.CMYK',
  'DocumentMode.LAB', 'DocumentMode.BITMAP', 'DocumentMode.INDEXEDCOLOR', 'DocumentMode.DUOTONE',
  'DocumentMode.MULTICHANNEL']);

var JUSTIFICATIONS = dshEnumTable(['Justification.LEFT', 'Justification.CENTER', 'Justification.RIGHT',
  'Justification.JUSTIFIEDLEFT', 'Justification.JUSTIFIEDCENTER', 'Justification.JUSTIFIEDRIGHT',
  'Justification.JUSTIFIEDLASTLINELEFT']);

function dshBoundsOf(layer) {
  try {
    var bounds = layer.bounds;
    return [Math.round(bounds[0].value), Math.round(bounds[1].value),
      Math.round(bounds[2].value), Math.round(bounds[3].value)];
  } catch (error) {
    return null;
  }
}

function dshMaskFacts(layerID) {
  var facts = { mask: false, vectorMask: false, effects: false };
  try {
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID('Lyr '), layerID);
    var descriptor = executeActionGet(ref);
    if (descriptor.hasKey(stringIDToTypeID('userMaskEnabled'))) {
      facts.mask = true;
      try { facts.maskEnabled = descriptor.getBoolean(stringIDToTypeID('userMaskEnabled')); } catch (readError) { }
    }
    facts.vectorMask = descriptor.hasKey(stringIDToTypeID('vectorMaskEnabled'));
    facts.effects = descriptor.hasKey(stringIDToTypeID('layerEffects'));
  } catch (error) {
    facts.error = String(error.message ? error.message : error);
  }
  return facts;
}

function dshDescribeLayer(layer, depth, path, namePath) {
  var entry = {
    path: path,
    namePath: namePath,
    depth: depth,
    name: String(layer.name),
    type: String(layer.typename)
  };
  try { entry.visible = layer.visible === true; } catch (visibleError) { }
  try { entry.opacity = Math.round(layer.opacity); } catch (opacityError) { }
  try { entry.fillOpacity = Math.round(layer.fillOpacity); } catch (fillError) { }
  try { entry.blendMode = dshNameOf(BLEND_MODES, layer.blendMode) || String(layer.blendMode).replace(/^blendmode\./i, '').toUpperCase(); } catch (blendError) { }
  try { entry.allLocked = layer.allLocked === true; } catch (lockError) { }
  try { entry.clipping = layer.grouped === true; } catch (clippingError) { }
  try { entry.isBackground = layer.isBackgroundLayer === true; } catch (backgroundError) { }
  entry.bounds = dshBoundsOf(layer);

  if (entry.type === 'ArtLayer') {
    try { entry.kind = dshNameOf(LAYER_KINDS, layer.kind) || ('kind#' + String(layer.kind)); } catch (kindError) { }
    if (entry.kind === 'TEXT') {
      try {
        entry.text = String(layer.textItem.contents);
        entry.textSize = Math.round(layer.textItem.size.value * 100) / 100;
        entry.textUnits = String(layer.textItem.size.type === undefined ? 'px' : 'px');
        entry.font = String(layer.textItem.font);
        entry.justification = dshNameOf(JUSTIFICATIONS, layer.textItem.justification) || null;
      } catch (textError) {
        entry.textError = String(textError.message ? textError.message : textError);
      }
    }
  }

  if (entry.type === 'LayerSet') {
    try { entry.children = layer.layers.length; } catch (childrenError) { }
  }

  try {
    var facts = dshMaskFacts(layer.id);
    entry.mask = facts.mask;
    if (facts.maskEnabled !== undefined) entry.maskEnabled = facts.maskEnabled;
    entry.vectorMask = facts.vectorMask;
    entry.effects = facts.effects;
  } catch (factsError) { }

  return entry;
}

function dshWalkLayers(container, depth, indexPath, namePath, collected) {
  for (var i = 0; i < container.length; i++) {
    if (collected.length >= DSH.maxLayers) { out.truncated = true; return collected; }
    var layer = container[i];
    var path = indexPath === '' ? String(i) : indexPath + '.' + i;
    var childNamePath = namePath === '' ? String(layer.name) : namePath + '/' + String(layer.name);
    collected.push(dshDescribeLayer(layer, depth, path, childNamePath));
    if (String(layer.typename) === 'LayerSet') {
      try { dshWalkLayers(layer.layers, depth + 1, path, childNamePath, collected); }
      catch (descendError) { }
    }
  }
  return collected;
}

var previousDialogs = null;
try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  out.photoshop = { version: String(app.version), build: String(app.build) };
  out.openDocuments = [];
  for (var d = 0; d < app.documents.length; d++) {
    try { out.openDocuments.push(String(app.documents[d].name)); } catch (listError) { }
  }
  out.documentsOpen = app.documents.length;

  if (app.documents.length === 0) {
    out.document = null;
  } else {
    var doc = null;
    if (DSH.documentName) {
      for (var m = 0; m < app.documents.length; m++) {
        if (String(app.documents[m].name) === DSH.documentName) { doc = app.documents[m]; break; }
      }
      if (doc === null) {
        out.ok = false;
        out.error = 'no open document named "' + DSH.documentName + '"';
      }
    } else {
      doc = app.activeDocument;
    }

    if (doc !== null) {
      out.document = {
        name: String(doc.name),
        width: Math.round(doc.width.value),
        height: Math.round(doc.height.value),
        resolution: Math.round(doc.resolution * 100) / 100,
        mode: dshNameOf(DOCUMENT_MODES, doc.mode) || String(doc.mode),
        bitsPerChannel: dshBitsName(doc.bitsPerChannel),
        colorProfile: String(doc.colorProfileName),
        saved: doc.saved === true
      };
      try {
        if (String(doc.fullName) !== String(doc.name)) out.document.path = String(doc.fullName);
      } catch (pathError) { }
      try { out.document.isActive = (String(doc.name) === String(app.activeDocument.name)); } catch (activeError) { }
      try { out.document.activeLayer = String(doc.activeLayer.name); } catch (activeLayerError) { }
      try { out.document.channels = doc.channels.length; } catch (channelsError) { }
      try { out.document.pathItems = doc.pathItems.length; } catch (pathsError) { }
      try { out.document.guides = doc.guides.length; } catch (guidesError) { }
      try {
        out.document.history = {
          states: doc.historyStates.length,
          current: String(doc.activeHistoryState.name)
        };
      } catch (historyError) { }
      try {
        out.document.xmpBytes = String(doc.xmpMetadata.rawData).length;
      } catch (xmpError) { }
      try {
        var selectionBounds = doc.selection.bounds;
        if (selectionBounds) {
          out.document.selection = [Math.round(selectionBounds[0].value), Math.round(selectionBounds[1].value),
            Math.round(selectionBounds[2].value), Math.round(selectionBounds[3].value)];
        }
      } catch (selectionError) {
        out.document.selection = null;
      }

      var collected = [];
      dshWalkLayers(doc.layers, 0, '', '', collected);
      out.layers = collected;
    }
  }
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
} finally {
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_INSPECT_DONE'
`
}

/**
 * Wrap a caller-written body in the shared harness. The body may use `DSH`,
 * `dshWrite`, `dshJson`, `dshCancelled` and the Photoshop DOM, and is expected
 * to write its own result to `DSH.resultPath`. Used by capability probes and by
 * any future recipe that is too specific to deserve its own builder.
 * @param params - embedded verbatim as the `DSH` object.
 * @param body - ExtendScript statements.
 * @returns ExtendScript source.
 */
export function customScript(params, body) {
  return `${prelude(params)}
${body}
`
}

/**
 * Run a caller-supplied ExtendScript verbatim and hand back whatever it
 * evaluates to. This is the escape hatch: anything Photoshop can script is
 * reachable without waiting for a dedicated recipe.
 * @param params - must carry `code` and `resultPath`.
 * @returns ExtendScript source.
 */
export function rawScript(params) {
  return `${prelude(params)}
var out = { ok: true, tool: 'photoshop_run_jsx' };
var previousDialogs = null;
try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;
  var produced = eval(DSH.code);
  if (produced === undefined || produced === null) out.result = null;
  else if (typeof produced === 'string') out.result = produced;
  else if (produced instanceof Array) out.result = produced.join('\\n');
  else out.result = String(produced);
  out.resultType = typeof produced;
  out.documentsOpen = app.documents.length;
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
  try { out.errorLine = error.line; } catch (lineError) { }
} finally {
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_RUN_DONE'
`
}
