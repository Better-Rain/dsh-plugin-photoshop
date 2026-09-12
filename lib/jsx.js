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
 * @param params - the recipe parameters, embedded verbatim.
 * @returns ExtendScript source.
 */
function prelude(params) {
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
