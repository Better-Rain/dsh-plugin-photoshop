/**
 * dsh-plugin-photoshop — the operation handlers.
 *
 * One generated ExtendScript program carries the whole vocabulary as a registry
 * of `name: function (op, doc)` handlers plus a dispatcher. Node sends the plan
 * as JSON and Photoshop executes it, which means a plan of any length costs one
 * COM round trip and can be wrapped in a single undo step.
 *
 * Three rules hold throughout:
 *
 *  - **Every handler validates what it is given** and throws a message naming the
 *    operation, because a plan is written by a model and a silent no-op is worse
 *    than a refusal.
 *  - **Layers are addressed, never guessed.** `dshResolveLayer` accepts the index
 *    path and the name path that `photoshop_inspect` prints, so the two tools
 *    share one addressing scheme.
 *  - **Nothing is written to an input file.** The only op that touches disk is
 *    `save_as`, which writes a copy to a path the caller named.
 *
 * The handler names are the vocabulary. `test/e2e.mjs` asks Photoshop for this
 * list and asserts it matches `lib/vocabulary.js`, so documentation and
 * behaviour cannot drift apart unnoticed.
 */

import { prelude } from './jsx.js'

/** The handler registry and dispatcher, as ExtendScript source. */
const HANDLERS = `
var DSH_RESULT = { started: false, applied: [] };

/**
 * Build a name → enumeration-value table once, at load time.
 *
 * The values are resolved here rather than at call time on purpose: a plan can
 * run inside the script string that suspendHistory evaluates, and eval in
 * that nested scope does not reliably see Photoshop's global host objects — a
 * call-time lookup silently yields undefined, which Photoshop then rejects with
 * a bare "invalid enumeration value". Resolving eagerly also means a member this
 * version does not have simply never appears in the table, and dshEnum reports
 * which names are actually available.
 */
function dshEnumTable(typeName, members) {
  var table = {};
  for (var key in members) {
    if (!members.hasOwnProperty(key)) continue;
    try {
      var value = eval(typeName + '.' + members[key]);
      if (value !== undefined && value !== null) table[key] = value;
    } catch (error) { }
  }
  return table;
}

var BLEND_BY_NAME = dshEnumTable('BlendMode', {
  normal: 'NORMAL', dissolve: 'DISSOLVE', darken: 'DARKEN', multiply: 'MULTIPLY', colorburn: 'COLORBURN',
  linearburn: 'LINEARBURN', lighten: 'LIGHTEN', screen: 'SCREEN', colordodge: 'COLORDODGE',
  lineardodge: 'LINEARDODGE', overlay: 'OVERLAY', softlight: 'SOFTLIGHT', hardlight: 'HARDLIGHT',
  vividlight: 'VIVIDLIGHT', linearlight: 'LINEARLIGHT', pinlight: 'PINLIGHT', hardmix: 'HARDMIX',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', subtract: 'SUBTRACT', divide: 'DIVIDE',
  hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
  darkercolor: 'DARKERCOLOR', lightercolor: 'LIGHTERCOLOR', passthrough: 'PASSTHROUGH'
});

var ANCHOR_BY_NAME = dshEnumTable('AnchorPosition', {
  top_left: 'TOPLEFT', top_center: 'TOPCENTER', top_right: 'TOPRIGHT',
  middle_left: 'MIDDLELEFT', center: 'MIDDLECENTER', middle_center: 'MIDDLECENTER',
  middle_right: 'MIDDLERIGHT', bottom_left: 'BOTTOMLEFT', bottom_center: 'BOTTOMCENTER',
  bottom_right: 'BOTTOMRIGHT'
});

var RESAMPLE_BY_NAME = dshEnumTable('ResampleMethod', {
  nearest: 'NEARESTNEIGHBOR', bilinear: 'BILINEAR', bicubic: 'BICUBIC',
  bicubic_smoother: 'BICUBICSMOOTHER', bicubic_sharper: 'BICUBICSHARPER'
});

var FILL_BY_NAME = dshEnumTable('DocumentFill', {
  white: 'WHITE', transparent: 'TRANSPARENT', background: 'BACKGROUNDCOLOR'
});

// Changing an existing document's mode and creating a new one take two different
// enumerations; passing one where the other belongs is an "invalid enumeration
// value" with no further explanation, so they are kept apart deliberately.
var MODE_BY_NAME = dshEnumTable('ChangeMode', {
  rgb: 'RGB', grayscale: 'GRAYSCALE', cmyk: 'CMYK', lab: 'LAB', bitmap: 'BITMAP',
  multichannel: 'MULTICHANNEL', indexed: 'INDEXEDCOLOR'
});

var NEW_DOCUMENT_MODE_BY_NAME = dshEnumTable('NewDocumentMode', {
  rgb: 'RGB', grayscale: 'GRAYSCALE', cmyk: 'CMYK', lab: 'LAB', bitmap: 'BITMAP'
});

var INTENT_BY_NAME = dshEnumTable('Intent', {
  perceptual: 'PERCEPTUAL', relative_colorimetric: 'RELATIVECOLORIMETRIC',
  saturation: 'SATURATION', absolute_colorimetric: 'ABSOLUTECOLORIMETRIC'
});

var JUSTIFY_BY_NAME = dshEnumTable('Justification', {
  left: 'LEFT', center: 'CENTER', right: 'RIGHT', justified: 'JUSTIFIEDLEFT'
});

var SMART_BLUR_MODE = dshEnumTable('SmartBlurMode', {
  normal: 'NORMAL', edge_only: 'EDGEONLY', overlay_edge_only: 'OVERLAYPEONLY'
});

var SMART_BLUR_QUALITY = dshEnumTable('SmartBlurQuality', {
  low: 'LOW', medium: 'MEDIUM', high: 'HIGH'
});

var RADIAL_BLUR_METHOD = dshEnumTable('RadialBlurMethod', { spin: 'SPIN', zoom: 'ZOOM' });

// Radial blur and smart blur each have their own quality enumeration; they are
// not interchangeable even though both are called "quality".
var RADIAL_BLUR_QUALITY = dshEnumTable('RadialBlurQuality', { draft: 'DRAFT', good: 'GOOD', best: 'BEST' });

var NOISE_DISTRIBUTION = dshEnumTable('NoiseDistribution', { uniform: 'UNIFORM', gaussian: 'GAUSSIAN' });

var OFFSET_WRAP = dshEnumTable('OffsetUndefinedAreas', {
  wraparound: 'WRAPAROUND', repeat_edge: 'REPEATEDGEPIXELS'
});

var SPHERIZE_MODE = dshEnumTable('SpherizeMode', {
  normal: 'NORMAL', horizontal_only: 'HORIZONTALONLY', vertical_only: 'VERTICALONLY'
});

function dshNumber(value, what, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(what + ' is required');
  }
  var number = Number(value);
  if (isNaN(number)) throw new Error(what + ' must be a number, got ' + String(value));
  return number;
}

function dshPx(value, what, fallback) {
  return UnitValue(dshNumber(value, what, fallback), 'px');
}

function dshBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true;
}

function dshColor(value, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error('a colour is required — use "#rrggbb" or { r: 0-255, g: …, b: … }');
    return fallback;
  }
  var colour = new SolidColor();
  if (typeof value === 'string') {
    var hex = String(value).replace('#', '');
    if (hex.length !== 6) throw new Error('colour "' + value + '" must be a 6-digit hex value like "#ff8800"');
    colour.rgb.red = parseInt(hex.substring(0, 2), 16);
    colour.rgb.green = parseInt(hex.substring(2, 4), 16);
    colour.rgb.blue = parseInt(hex.substring(4, 6), 16);
    return colour;
  }
  colour.rgb.red = Math.round(dshNumber(value.r, 'colour.r'));
  colour.rgb.green = Math.round(dshNumber(value.g, 'colour.g'));
  colour.rgb.blue = Math.round(dshNumber(value.b, 'colour.b'));
  return colour;
}

function dshColorDescriptor(value) {
  var descriptor = new ActionDescriptor();
  if (typeof value === 'string') {
    var hex = String(value).replace('#', '');
    if (hex.length !== 6) throw new Error('colour "' + value + '" must be a 6-digit hex value like "#ff8800"');
    descriptor.putDouble(charIDToTypeID('Rd  '), parseInt(hex.substring(0, 2), 16));
    descriptor.putDouble(charIDToTypeID('Grn '), parseInt(hex.substring(2, 4), 16));
    descriptor.putDouble(charIDToTypeID('Bl  '), parseInt(hex.substring(4, 6), 16));
    return descriptor;
  }
  descriptor.putDouble(charIDToTypeID('Rd  '), dshNumber(value.r, 'colour.r'));
  descriptor.putDouble(charIDToTypeID('Grn '), dshNumber(value.g, 'colour.g'));
  descriptor.putDouble(charIDToTypeID('Bl  '), dshNumber(value.b, 'colour.b'));
  return descriptor;
}

/** Look up a name in an already-resolved enum table. */
function dshEnum(table, value, what) {
  var resolved = table[String(value).toLowerCase()];
  if (resolved === undefined) {
    var allowed = [];
    for (var key in table) { if (table.hasOwnProperty(key)) allowed.push(key); }
    throw new Error(what + ' must be one of ' + allowed.join(', ') + ' — got "' + String(value) + '"');
  }
  return resolved;
}

function dshDocumentFor(op) {
  if (op.document !== undefined && op.document !== null && String(op.document) !== '') {
    var wanted = String(op.document);
    for (var i = 0; i < app.documents.length; i++) {
      if (String(app.documents[i].name) === wanted) return app.documents[i];
    }
    throw new Error('no open document named "' + wanted + '"');
  }
  if (app.documents.length === 0) throw new Error('no document is open');
  return app.activeDocument;
}

function dshLayerNames(container, prefix, collected) {
  for (var i = 0; i < container.length; i++) {
    var layer = container[i];
    var path = prefix === '' ? String(i) : prefix + '.' + i;
    collected.push({ name: String(layer.name), path: path });
    if (String(layer.typename) === 'LayerSet') {
      try { dshLayerNames(layer.layers, path, collected); } catch (error) { }
    }
  }
  return collected;
}

function dshResolveLayer(doc, selector) {
  if (selector === undefined || selector === null || String(selector) === '') return doc.activeLayer;
  var text = String(selector);

  if (/^[0-9]+(\\.[0-9]+)*$/.test(text)) {
    var parts = text.split('.');
    var container = doc.layers;
    var found = null;
    for (var i = 0; i < parts.length; i++) {
      if (container === null) throw new Error('"' + text + '" descends into a layer that is not a group');
      found = container[parseInt(parts[i], 10)];
      if (found === undefined || found === null) throw new Error('no layer at index path "' + text + '"');
      container = String(found.typename) === 'LayerSet' ? found.layers : null;
    }
    return found;
  }

  var names = text.split('/');
  if (names.length === 1) {
    var matches = [];
    var all = dshLayerNames(doc.layers, '', []);
    for (var m = 0; m < all.length; m++) {
      if (all[m].name === names[0]) matches.push(all[m]);
    }
    if (matches.length === 0) throw new Error('no layer named "' + names[0] + '" — run photoshop_inspect to see the layer tree');
    if (matches.length > 1) {
      var paths = [];
      for (var p = 0; p < matches.length; p++) paths.push(matches[p].path);
      throw new Error('"' + names[0] + '" is ambiguous; address it by index path: ' + paths.join(' or '));
    }
    return dshResolveLayer(doc, matches[0].path);
  }

  var current = doc.layers;
  var layer = null;
  for (var n = 0; n < names.length; n++) {
    layer = null;
    for (var c = 0; c < current.length; c++) {
      if (String(current[c].name) === names[n]) { layer = current[c]; break; }
    }
    if (layer === null) throw new Error('no layer named "' + names[n] + '" inside "' + names.slice(0, n).join('/') + '"');
    current = String(layer.typename) === 'LayerSet' ? layer.layers : null;
  }
  return layer;
}

/** Make a layer the active one, which several ActionManager commands require. */
function dshSelectLayer(layer) {
  var ref = new ActionReference();
  ref.putIdentifier(charIDToTypeID('Lyr '), layer.id);
  var desc = new ActionDescriptor();
  desc.putReference(charIDToTypeID('null'), ref);
  desc.putBoolean(charIDToTypeID('MkVs'), false);
  executeAction(charIDToTypeID('slct'), desc, DialogModes.NO);
}

/**
 * Resolve an op's target layer and make it the active one.
 *
 * Many Photoshop DOM layer operations — the adjustment and filter methods above
 * all — are implemented over ActionManager and act on the layer that is
 * *selected*, not on the object they were called on. Skipping this is how a
 * targeted adjustment ends up applied to whatever happened to be active, or
 * fails with "the current layer is empty".
 */
function dshTargetLayer(doc, op) {
  var layer = dshResolveLayer(doc, op.target);
  dshSelectLayer(layer);
  return layer;
}

function dshRequireUnlocked(layer, what) {
  if (layer.isBackgroundLayer === true) {
    throw new Error('"' + layer.name + '" is a background layer, which cannot take ' + what + ' — run the unlock_background operation on it first');
  }
}

function dshHasSelection(doc) {
  try { return doc.selection.bounds !== undefined; } catch (error) { return false; }
}

/**
 * Write one document to disk. Shared by the save_as operation and the batch
 * auto-save so both accept exactly the same formats and refuse the same things.
 * Always a copy: the document keeps its own file reference, which is what makes
 * it impossible for this plugin to overwrite an input.
 */
function dshSaveAs(doc, path, format, quality, overwrite) {
  var kind = String(format === undefined || format === null ? 'png' : format).toLowerCase();
  var target = new File(String(path));
  if (target.exists) {
    if (overwrite !== true) throw new Error('output exists: ' + path + ' (pass overwrite: true to replace it)');
    target.remove();
  }
  var options = null;
  if (kind === 'png') { options = new PNGSaveOptions(); options.compression = 6; }
  else if (kind === 'jpeg' || kind === 'jpg') { options = new JPEGSaveOptions(); options.quality = quality; }
  else if (kind === 'psd') { options = new PhotoshopSaveOptions(); }
  else if (kind === 'tiff' || kind === 'tif') { options = new TiffSaveOptions(); }
  else throw new Error('format must be png, jpeg, psd or tiff — got "' + kind + '"');
  doc.saveAs(target, options, true, Extension.LOWERCASE);
  // Photoshop normalises some extensions ("jpeg" becomes ".jpg"), so the file it
  // wrote is not always the file we named. Report the one that exists.
  if (!target.exists) {
    var alternatives = kind === 'jpeg' || kind === 'jpg' ? ['jpg', 'jpeg'] : kind === 'tiff' || kind === 'tif' ? ['tif', 'tiff'] : [];
    var stem = target.fsName.replace(/\\.[^.]*$/, '');
    for (var a = 0; a < alternatives.length; a++) {
      var probe = new File(stem + '.' + alternatives[a]);
      if (probe.exists) return probe;
    }
    throw new Error('Photoshop reported success but wrote no file at ' + path);
  }
  return target;
}

function dshMaskReference() {
  var ref = new ActionReference();
  ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), stringIDToTypeID('mask'));
  return ref;
}

var HANDLERS = {

  // ── document ──────────────────────────────────────────────────────────────
  open: function (op) {
    var file = new File(String(op.path));
    if (!file.exists) throw new Error('file not found: ' + op.path);
    app.open(file);
  },

  new_document: function (op) {
    app.documents.add(
      dshNumber(op.width, 'width'),
      dshNumber(op.height, 'height'),
      dshNumber(op.resolution, 'resolution', 72),
      op.name === undefined ? 'Untitled' : String(op.name),
      dshEnum(NEW_DOCUMENT_MODE_BY_NAME, op.mode === undefined ? 'rgb' : op.mode, 'mode'),
      dshEnum(FILL_BY_NAME, op.fill === undefined ? 'white' : op.fill, 'fill')
    );
  },

  close: function (op) {
    var doc = dshDocumentFor(op);
    var isSaved = false;
    try { isSaved = doc.saved === true; } catch (error) { }
    var save = dshBool(op.save, false);
    if (!isSaved && !save && op.discard !== true) {
      throw new Error('"' + doc.name + '" has unsaved changes — pass discard: true to close without saving, or save: true to keep them');
    }
    doc.close(save ? SaveOptions.SAVECHANGES : SaveOptions.DONOTSAVECHANGES);
  },

  save_as: function (op, doc) {
    dshSaveAs(doc, op.path, op.format, dshNumber(op.quality, 'quality', 10), op.overwrite === true);
  },

  resize_image: function (op, doc) {
    var width = op.width === undefined ? null : dshNumber(op.width, 'width');
    var height = op.height === undefined ? null : dshNumber(op.height, 'height');
    if (op.max_side !== undefined) {
      var currentWidth = doc.width.value;
      var currentHeight = doc.height.value;
      var longest = currentWidth > currentHeight ? currentWidth : currentHeight;
      var limit = dshNumber(op.max_side, 'max_side');
      if (longest > limit) {
        var scale = limit / longest;
        width = Math.round(currentWidth * scale);
        height = Math.round(currentHeight * scale);
      } else {
        width = Math.round(currentWidth);
        height = Math.round(currentHeight);
      }
    }
    if (width === null || height === null) throw new Error('resize_image needs width and height, or max_side');
    doc.resizeImage(
      UnitValue(width, 'px'), UnitValue(height, 'px'),
      dshNumber(op.resolution, 'resolution', doc.resolution),
      dshEnum(RESAMPLE_BY_NAME, op.resample === undefined ? 'bicubic' : op.resample, 'resample')
    );
  },

  resize_canvas: function (op, doc) {
    doc.resizeCanvas(dshPx(op.width, 'width'), dshPx(op.height, 'height'),
      dshEnum(ANCHOR_BY_NAME, op.anchor === undefined ? 'center' : op.anchor, 'anchor'));
  },

  crop: function (op, doc) {
    doc.crop([dshPx(op.left, 'left'), dshPx(op.top, 'top'), dshPx(op.right, 'right'), dshPx(op.bottom, 'bottom')]);
  },

  rotate_canvas: function (op, doc) {
    doc.rotateCanvas(dshNumber(op.angle, 'angle'));
  },

  flip_canvas: function (op, doc) {
    var axis = String(op.axis === undefined ? '' : op.axis).toLowerCase();
    if (axis === 'horizontal') doc.flipCanvas(Direction.HORIZONTAL);
    else if (axis === 'vertical') doc.flipCanvas(Direction.VERTICAL);
    else throw new Error('axis must be "horizontal" or "vertical"');
  },

  trim: function (op, doc) {
    var based = String(op.based_on === undefined ? 'transparent' : op.based_on).toLowerCase();
    var type = TrimType.TRANSPARENT;
    if (based === 'top_left_pixel' || based === 'top_left') type = TrimType.TOPLEFTPIXEL;
    else if (based === 'bottom_right_pixel' || based === 'bottom_right') type = TrimType.BOTTOMRIGHTPIXEL;
    else if (based !== 'transparent') throw new Error('based_on must be transparent, top_left_pixel or bottom_right_pixel');
    doc.trim(type);
  },

  flatten: function (op, doc) { doc.flatten(); },

  merge_visible: function (op, doc) { doc.mergeVisibleLayers(); },

  duplicate: function (op, doc) {
    doc.duplicate(op.name === undefined ? String(doc.name) + ' copy' : String(op.name), false);
  },

  change_mode: function (op, doc) {
    doc.changeMode(dshEnum(MODE_BY_NAME, op.mode, 'mode'));
  },

  convert_profile: function (op, doc) {
    doc.convertProfile(
      String(op.profile),
      dshEnum(INTENT_BY_NAME, op.intent === undefined ? 'relative_colorimetric' : op.intent, 'intent'),
      dshBool(op.black_point, true),
      dshBool(op.dither, true)
    );
  },

  // ── layer ─────────────────────────────────────────────────────────────────
  add_layer: function (op, doc) {
    var layer = doc.artLayers.add();
    if (op.name !== undefined) layer.name = String(op.name);
    return layer;
  },

  add_group: function (op, doc) {
    var set = doc.layerSets.add();
    if (op.name !== undefined) set.name = String(op.name);
    return set;
  },

  unlock_background: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    if (layer.isBackgroundLayer !== true) throw new Error('"' + layer.name + '" is not a background layer');
    layer.isBackgroundLayer = false;
  },

  delete_layer: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    try { layer.remove(); }
    catch (removeError) {
      var ref = new ActionReference();
      ref.putIdentifier(charIDToTypeID('Lyr '), layer.id);
      var desc = new ActionDescriptor();
      desc.putReference(charIDToTypeID('null'), ref);
      executeAction(charIDToTypeID('Dlt '), desc, DialogModes.NO);
    }
  },

  duplicate_layer: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var copy = layer.duplicate();
    if (op.name !== undefined) copy.name = String(op.name);
    return copy;
  },

  rename_layer: function (op, doc) {
    dshTargetLayer(doc, op).name = String(op.name);
  },

  set_opacity: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var value = dshNumber(op.value, 'value');
    if (layer.isBackgroundLayer === true && value !== 100) {
      throw new Error('a background layer is always fully opaque — run unlock_background on it first');
    }
    layer.opacity = Math.max(0, Math.min(100, value));
  },

  set_fill_opacity: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshRequireUnlocked(layer, 'a fill opacity');
    layer.fillOpacity = Math.max(0, Math.min(100, dshNumber(op.value, 'value')));
  },

  set_blend_mode: function (op, doc) {
    dshTargetLayer(doc, op).blendMode = dshEnum(BLEND_BY_NAME, op.mode, 'mode');
  },

  set_visibility: function (op, doc) {
    dshTargetLayer(doc, op).visible = dshBool(op.visible, true);
  },

  set_lock: function (op, doc) {
    dshTargetLayer(doc, op).allLocked = dshBool(op.locked, true);
  },

  move_layer: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var destination = dshResolveLayer(doc, op.into);
    if (layer.isBackgroundLayer === true) {
      throw new Error('a background layer cannot be moved — run unlock_background on it first');
    }
    var placement = String(op.placement === undefined ? 'inside' : op.placement).toLowerCase();
    var element = ElementPlacement.INSIDE;
    if (placement === 'before') element = ElementPlacement.PLACEBEFORE;
    else if (placement === 'after') element = ElementPlacement.PLACEAFTER;
    else if (placement !== 'inside') throw new Error('placement must be inside, before or after');
    if (placement === 'inside' && String(destination.typename) !== 'LayerSet') {
      throw new Error('placement "inside" needs a layer group, but "' + destination.name + '" is not one');
    }
    layer.move(destination, element);
  },

  ungroup: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    if (String(layer.typename) !== 'LayerSet') throw new Error('"' + layer.name + '" is not a group');
    // dshTargetLayer already selected it, so the Trgt reference names the group.
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    desc.putReference(charIDToTypeID('null'), ref);
    executeAction(stringIDToTypeID('ungroupLayersEvent'), desc, DialogModes.NO);
  },

  rasterize: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var kind = null;
    try { kind = layer.kind; } catch (error) { }
    if (kind === LayerKind.NORMAL) throw new Error('"' + layer.name + '" is already a pixel layer — nothing to rasterize');
    layer.rasterize(RasterizeType.ENTIRELAYER);
  },

  to_smart_object: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putClass(stringIDToTypeID('smartObject'));
    desc.putReference(charIDToTypeID('null'), ref);
    var target = new ActionReference();
    target.putIdentifier(charIDToTypeID('Lyr '), layer.id);
    desc.putReference(charIDToTypeID('Lyr '), target);
    executeAction(stringIDToTypeID('newPlacedLayer'), desc, DialogModes.NO);
  },

  merge_down: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshSelectLayer(layer);
    executeAction(stringIDToTypeID('mergeLayers'), new ActionDescriptor(), DialogModes.NO);
  },

  add_mask: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshRequireUnlocked(layer, 'a layer mask');
    var mode = String(op.mode === undefined ? 'reveal_all' : op.mode).toLowerCase();
    var userMask = charIDToTypeID('RvlA');
    if (mode === 'hide_all') userMask = charIDToTypeID('HdAl');
    else if (mode === 'from_selection') {
      if (!dshHasSelection(doc)) throw new Error('mode "from_selection" needs an active selection — make one first');
      userMask = charIDToTypeID('RvlS');
    } else if (mode !== 'reveal_all') throw new Error('mode must be reveal_all, hide_all or from_selection');
    dshSelectLayer(layer);
    var desc = new ActionDescriptor();
    desc.putClass(charIDToTypeID('Nw  '), charIDToTypeID('Chnl'));
    var at = new ActionReference();
    at.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Msk '));
    desc.putReference(charIDToTypeID('At  '), at);
    desc.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('UsrM'), userMask);
    executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
  },

  delete_mask: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshSelectLayer(layer);
    var desc = new ActionDescriptor();
    desc.putReference(charIDToTypeID('null'), dshMaskReference());
    executeAction(charIDToTypeID('Dlt '), desc, DialogModes.NO);
  },

  apply_mask: function (op, doc) {
    dshSelectLayer(dshTargetLayer(doc, op));
    executeAction(stringIDToTypeID('applyLayerMask'), undefined, DialogModes.NO);
  },

  invert_mask: function (op, doc) {
    dshSelectLayer(dshTargetLayer(doc, op));
    var desc = new ActionDescriptor();
    desc.putReference(charIDToTypeID('null'), dshMaskReference());
    executeAction(stringIDToTypeID('inverse'), desc, DialogModes.NO);
  },

  clipping_mask: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    if (dshBool(op.enabled, true)) {
      var desc = new ActionDescriptor();
      var ref = new ActionReference();
      ref.putIdentifier(charIDToTypeID('Lyr '), layer.id);
      desc.putReference(charIDToTypeID('null'), ref);
      desc.putBoolean(stringIDToTypeID('group'), true);
      executeAction(stringIDToTypeID('groupEvent'), desc, DialogModes.NO);
    } else {
      // Releasing has no working ActionManager command on this build —
      // releaseClippingMask is not available and groupEvent with group=false is
      // rejected — but the layer's own read-write grouped property does it.
      layer.grouped = false;
    }
  },

  layer_style: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshRequireUnlocked(layer, 'a layer style');
    var style = String(op.style === undefined ? '' : op.style).toLowerCase();
    var effects = new ActionDescriptor();

    if (style === 'drop_shadow' || style === 'inner_shadow') {
      var shadow = new ActionDescriptor();
      shadow.putBoolean(stringIDToTypeID('enabled'), true);
      shadow.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), dshNumber(op.opacity, 'opacity', 60));
      shadow.putUnitDouble(stringIDToTypeID('distance'), stringIDToTypeID('pixelsUnit'), dshNumber(op.distance, 'distance', 6));
      shadow.putUnitDouble(stringIDToTypeID('size'), stringIDToTypeID('pixelsUnit'), dshNumber(op.size, 'size', 4));
      if (op.angle !== undefined) shadow.putUnitDouble(stringIDToTypeID('angle'), stringIDToTypeID('angleUnit'), dshNumber(op.angle, 'angle'));
      if (op.color !== undefined) shadow.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), dshColorDescriptor(op.color));
      var shadowKey = style === 'drop_shadow' ? 'dropShadow' : 'innerShadow';
      effects.putObject(stringIDToTypeID(shadowKey), stringIDToTypeID(shadowKey), shadow);
    } else if (style === 'outer_glow' || style === 'inner_glow') {
      var glow = new ActionDescriptor();
      glow.putBoolean(stringIDToTypeID('enabled'), true);
      glow.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), dshNumber(op.opacity, 'opacity', 60));
      glow.putUnitDouble(stringIDToTypeID('size'), stringIDToTypeID('pixelsUnit'), dshNumber(op.size, 'size', 6));
      if (op.color !== undefined) glow.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), dshColorDescriptor(op.color));
      var glowKey = style === 'outer_glow' ? 'outerGlow' : 'innerGlow';
      effects.putObject(stringIDToTypeID(glowKey), stringIDToTypeID(glowKey), glow);
    } else if (style === 'stroke') {
      var stroke = new ActionDescriptor();
      stroke.putBoolean(stringIDToTypeID('enabled'), true);
      stroke.putUnitDouble(stringIDToTypeID('size'), stringIDToTypeID('pixelsUnit'), dshNumber(op.width, 'width', dshNumber(op.size, 'size', 3)));
      stroke.putUnitDouble(stringIDToTypeID('opacity'), stringIDToTypeID('percentUnit'), dshNumber(op.opacity, 'opacity', 100));
      stroke.putObject(charIDToTypeID('Clr '), stringIDToTypeID('RGBColor'), dshColorDescriptor(op.color === undefined ? '#000000' : op.color));
      effects.putObject(stringIDToTypeID('frameFX'), stringIDToTypeID('frameFX'), stroke);
    } else {
      throw new Error('style must be drop_shadow, inner_shadow, outer_glow, inner_glow or stroke — got "' + style + '"');
    }

    dshSelectLayer(layer);
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('layerEffects'));
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    desc.putReference(charIDToTypeID('null'), ref);
    desc.putObject(charIDToTypeID('T   '), stringIDToTypeID('layerEffects'), effects);
    executeAction(charIDToTypeID('setd'), desc, DialogModes.NO);
  },

  // ── adjust ────────────────────────────────────────────────────────────────
  levels: function (op, doc) {
    dshTargetLayer(doc, op).adjustLevels(
      dshNumber(op.input_black, 'input_black', 0), dshNumber(op.input_white, 'input_white', 255),
      dshNumber(op.gamma, 'gamma', 1), dshNumber(op.output_black, 'output_black', 0),
      dshNumber(op.output_white, 'output_white', 255));
  },

  brightness_contrast: function (op, doc) {
    dshTargetLayer(doc, op).adjustBrightnessContrast(
      dshNumber(op.brightness, 'brightness', 0), dshNumber(op.contrast, 'contrast', 0));
  },

  hue_saturation: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    dshSelectLayer(layer);
    var desc = new ActionDescriptor();
    desc.putEnumerated(stringIDToTypeID('presetKind'), stringIDToTypeID('presetKindType'), stringIDToTypeID('presetKindCustom'));
    var list = new ActionList();
    var range = new ActionDescriptor();
    range.putInteger(stringIDToTypeID('hue'), Math.round(dshNumber(op.hue, 'hue', 0)));
    range.putInteger(stringIDToTypeID('saturation'), Math.round(dshNumber(op.saturation, 'saturation', 0)));
    range.putInteger(stringIDToTypeID('lightness'), Math.round(dshNumber(op.lightness, 'lightness', 0)));
    list.putObject(stringIDToTypeID('hueAdjustment'), range);
    desc.putList(stringIDToTypeID('adjustment'), list);
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    desc.putReference(charIDToTypeID('null'), ref);
    executeAction(stringIDToTypeID('hueSaturation'), desc, DialogModes.NO);
  },

  vibrance: function (op, doc) {
    dshSelectLayer(dshTargetLayer(doc, op));
    var desc = new ActionDescriptor();
    desc.putInteger(stringIDToTypeID('vibrance'), Math.round(dshNumber(op.vibrance, 'vibrance', 0)));
    desc.putInteger(stringIDToTypeID('saturation'), Math.round(dshNumber(op.saturation, 'saturation', 0)));
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    desc.putReference(charIDToTypeID('null'), ref);
    executeAction(stringIDToTypeID('vibrance'), desc, DialogModes.NO);
  },

  black_white: function (op, doc) {
    dshSelectLayer(dshTargetLayer(doc, op));
    var desc = new ActionDescriptor();
    desc.putEnumerated(stringIDToTypeID('presetKind'), stringIDToTypeID('presetKindType'), stringIDToTypeID('presetKindDefault'));
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    desc.putReference(charIDToTypeID('null'), ref);
    executeAction(stringIDToTypeID('blackAndWhite'), desc, DialogModes.NO);
  },

  desaturate: function (op, doc) { dshTargetLayer(doc, op).desaturate(); },
  invert: function (op, doc) { dshTargetLayer(doc, op).invert(); },
  equalize: function (op, doc) { dshTargetLayer(doc, op).equalize(); },

  threshold: function (op, doc) {
    dshTargetLayer(doc, op).threshold(dshNumber(op.level, 'level', 128));
  },

  posterize: function (op, doc) {
    dshTargetLayer(doc, op).posterize(dshNumber(op.levels, 'levels', 8));
  },

  auto_levels: function (op, doc) { dshTargetLayer(doc, op).autoLevels(); },
  auto_contrast: function (op, doc) { dshTargetLayer(doc, op).autoContrast(); },

  // ── filter ────────────────────────────────────────────────────────────────
  gaussian_blur: function (op, doc) {
    dshTargetLayer(doc, op).applyGaussianBlur(dshNumber(op.radius, 'radius'));
  },

  motion_blur: function (op, doc) {
    dshTargetLayer(doc, op).applyMotionBlur(dshNumber(op.angle, 'angle'), dshNumber(op.distance, 'distance'));
  },

  radial_blur: function (op, doc) {
    // applyRadialBlur(amount, method, quality)
    dshTargetLayer(doc, op).applyRadialBlur(
      dshNumber(op.amount, 'amount'),
      dshEnum(RADIAL_BLUR_METHOD, op.method === undefined ? 'spin' : op.method, 'method'),
      dshEnum(RADIAL_BLUR_QUALITY, 'good', 'quality'));
  },

  smart_blur: function (op, doc) {
    // applySmartBlur(radius, threshold, quality, mode) — all four are required.
    dshTargetLayer(doc, op).applySmartBlur(
      dshNumber(op.radius, 'radius'),
      dshNumber(op.threshold, 'threshold'),
      dshEnum(SMART_BLUR_QUALITY, op.quality === undefined ? 'high' : op.quality, 'quality'),
      dshEnum(SMART_BLUR_MODE, op.mode === undefined ? 'normal' : op.mode, 'mode'));
  },

  unsharp_mask: function (op, doc) {
    dshTargetLayer(doc, op).applyUnSharpMask(
      dshNumber(op.amount, 'amount'), dshNumber(op.radius, 'radius'), dshNumber(op.threshold, 'threshold'));
  },

  sharpen: function (op, doc) { dshTargetLayer(doc, op).applySharpen(); },
  sharpen_more: function (op, doc) { dshTargetLayer(doc, op).applySharpenMore(); },
  sharpen_edges: function (op, doc) { dshTargetLayer(doc, op).applySharpenEdges(); },

  add_noise: function (op, doc) {
    dshTargetLayer(doc, op).applyAddNoise(
      dshNumber(op.amount, 'amount'),
      dshEnum(NOISE_DISTRIBUTION, op.distribution === undefined ? 'uniform' : op.distribution, 'distribution'),
      dshBool(op.monochromatic, false));
  },

  dust_and_scratches: function (op, doc) {
    dshTargetLayer(doc, op).applyDustAndScratches(dshNumber(op.radius, 'radius'), dshNumber(op.threshold, 'threshold'));
  },

  median_noise: function (op, doc) {
    dshTargetLayer(doc, op).applyMedianNoise(dshNumber(op.radius, 'radius'));
  },

  despeckle: function (op, doc) { dshTargetLayer(doc, op).applyDespeckle(); },

  high_pass: function (op, doc) {
    dshTargetLayer(doc, op).applyHighPass(dshNumber(op.radius, 'radius'));
  },

  maximum: function (op, doc) { dshTargetLayer(doc, op).applyMaximum(dshNumber(op.radius, 'radius')); },
  minimum: function (op, doc) { dshTargetLayer(doc, op).applyMinimum(dshNumber(op.radius, 'radius')); },

  offset: function (op, doc) {
    dshTargetLayer(doc, op).applyOffset(
      dshNumber(op.horizontal, 'horizontal'),
      dshNumber(op.vertical, 'vertical'),
      dshEnum(OFFSET_WRAP, op.wrap === undefined ? 'wraparound' : op.wrap, 'wrap'));
  },

  custom_filter: function (op, doc) {
    var kernel = op.kernel;
    if (!(kernel instanceof Array) || kernel.length !== 25) {
      throw new Error('kernel must be an array of 25 numbers (a 5x5 convolution)');
    }
    for (var i = 0; i < 25; i++) {
      if (isNaN(Number(kernel[i]))) throw new Error('kernel[' + i + '] must be a number');
    }
    dshTargetLayer(doc, op).applyCustomFilter(kernel, dshNumber(op.scale, 'scale', 1), dshNumber(op.offset, 'offset', 0));
  },

  pinch: function (op, doc) { dshTargetLayer(doc, op).applyPinch(dshNumber(op.amount, 'amount')); },

  spherize: function (op, doc) {
    dshTargetLayer(doc, op).applySpherize(
      dshNumber(op.amount, 'amount'),
      dshEnum(SPHERIZE_MODE, op.mode === undefined ? 'normal' : op.mode, 'mode'));
  },

  twirl: function (op, doc) { dshTargetLayer(doc, op).applyTwirl(dshNumber(op.angle, 'angle')); },

  // ── select ────────────────────────────────────────────────────────────────
  select_all: function (op, doc) { doc.selection.selectAll(); },
  deselect: function (op, doc) { doc.selection.deselect(); },
  invert_selection: function (op, doc) { doc.selection.invert(); },

  clear_selection: function (op, doc) {
    if (!dshHasSelection(doc)) throw new Error('there is no selection to clear — make one first');
    doc.selection.clear();
  },

  select_subject: function (op, doc) {
    executeAction(stringIDToTypeID('autoCutout'), new ActionDescriptor(), DialogModes.NO);
  },

  select_sky: function (op, doc) {
    executeAction(stringIDToTypeID('selectSky'), new ActionDescriptor(), DialogModes.NO);
  },

  remove_background: function (op, doc) {
    executeAction(stringIDToTypeID('removeBackground'), new ActionDescriptor(), DialogModes.NO);
  },

  expand: function (op, doc) { doc.selection.expand(dshPx(op.pixels, 'pixels')); },
  contract: function (op, doc) { doc.selection.contract(dshPx(op.pixels, 'pixels')); },
  feather: function (op, doc) { doc.selection.feather(dshPx(op.pixels, 'pixels')); },
  smooth: function (op, doc) { doc.selection.smooth(dshPx(op.radius, 'radius')); },
  border: function (op, doc) { doc.selection.selectBorder(dshPx(op.pixels, 'pixels')); },

  save_selection: function (op, doc) {
    if (!dshHasSelection(doc)) throw new Error('there is no selection to save');
    var channel = doc.channels.add();
    channel.name = String(op.name);
    doc.selection.store(channel);
  },

  load_selection: function (op, doc) {
    var wanted = String(op.name);
    var available = [];
    for (var i = 0; i < doc.channels.length; i++) {
      var name = String(doc.channels[i].name);
      available.push(name);
      if (name === wanted) { doc.selection.load(doc.channels[i]); return; }
    }
    throw new Error('no channel named "' + wanted + '" — this document has: ' + available.join(', '));
  },

  // ── paint ─────────────────────────────────────────────────────────────────
  add_text: function (op, doc) {
    var layer = doc.artLayers.add();
    layer.kind = LayerKind.TEXT;
    if (op.name !== undefined) layer.name = String(op.name);
    var text = layer.textItem;
    text.contents = op.contents === undefined ? '' : String(op.contents);
    if (op.size !== undefined) text.size = UnitValue(dshNumber(op.size, 'size'), 'px');
    if (op.color !== undefined) text.color = dshColor(op.color);
    if (op.font !== undefined) text.font = String(op.font);
    if (op.justification !== undefined) text.justification = dshEnum(JUSTIFY_BY_NAME, op.justification, 'justification');
    if (op.x !== undefined && op.y !== undefined) text.position = [dshPx(op.x, 'x'), dshPx(op.y, 'y')];
  },

  set_text: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    var kind = null;
    try { kind = layer.kind; } catch (error) { }
    if (kind !== LayerKind.TEXT) throw new Error('"' + layer.name + '" is not a text layer');
    var text = layer.textItem;
    if (op.contents !== undefined) text.contents = String(op.contents);
    if (op.size !== undefined) text.size = UnitValue(dshNumber(op.size, 'size'), 'px');
    if (op.color !== undefined) text.color = dshColor(op.color);
    if (op.font !== undefined) text.font = String(op.font);
    if (op.justification !== undefined) text.justification = dshEnum(JUSTIFY_BY_NAME, op.justification, 'justification');
  },

  fill: function (op, doc) {
    var layer = dshTargetLayer(doc, op);
    if (String(layer.typename) === 'LayerSet') {
      throw new Error('"' + layer.name + '" is a layer group, and a group cannot be filled — target a pixel layer');
    }
    var colour = dshColor(op.color);
    var hadSelection = dshHasSelection(doc);
    if (!hadSelection) doc.selection.selectAll();
    // preserve_transparency defaults to false: on a brand-new, fully transparent
    // layer "preserve transparency" fills nothing at all, which looks like a
    // successful no-op and only surfaces later as "the current layer is empty".
    doc.selection.fill(colour, ColorBlendMode.NORMAL, dshNumber(op.opacity, 'opacity', 100), dshBool(op.preserve_transparency, false));
    if (!hadSelection) doc.selection.deselect();
  },

  /**
   * A pixel layer filled with one colour. A live "Solid Color fill layer" would
   * be nicer — its colour stays editable — but creating a content layer through
   * ActionManager fails with a bare program error on this Photoshop build, so
   * this is the honest version of the same result.
   */
  add_color_layer: function (op, doc) {
    var layer = doc.artLayers.add();
    if (op.name !== undefined) layer.name = String(op.name);
    var colour = dshColor(op.color);
    var hadSelection = dshHasSelection(doc);
    if (!hadSelection) doc.selection.selectAll();
    doc.selection.fill(colour, ColorBlendMode.NORMAL, 100, false);
    if (!hadSelection) doc.selection.deselect();
  },

  // ── history ───────────────────────────────────────────────────────────────
  step_backward: function (op, doc) {
    var steps = Math.round(dshNumber(op.steps, 'steps', 1));
    for (var i = 0; i < steps; i++) {
      var states = doc.historyStates;
      var index = -1;
      for (var h = 0; h < states.length; h++) {
        if (states[h] === doc.activeHistoryState) { index = h; break; }
      }
      if (index <= 0) throw new Error('there is nothing left to undo');
      doc.activeHistoryState = states[index - 1];
    }
  },

  step_forward: function (op, doc) {
    var steps = Math.round(dshNumber(op.steps, 'steps', 1));
    for (var i = 0; i < steps; i++) {
      var states = doc.historyStates;
      var index = -1;
      for (var h = 0; h < states.length; h++) {
        if (states[h] === doc.activeHistoryState) { index = h; break; }
      }
      if (index < 0 || index >= states.length - 1) throw new Error('there is nothing left to redo');
      doc.activeHistoryState = states[index + 1];
    }
  },

  // ── metadata ──────────────────────────────────────────────────────────────
  set_metadata: function (op, doc) {
    var info = doc.info;
    var applied = 0;
    if (op.title !== undefined) { info.title = String(op.title); applied++; }
    if (op.author !== undefined) { info.author = String(op.author); applied++; }
    if (op.copyright !== undefined) { info.copyright = String(op.copyright); applied++; }
    if (op.description !== undefined) { info.description = String(op.description); applied++; }
    if (op.caption !== undefined) { info.caption = String(op.caption); applied++; }
    if (op.keywords !== undefined) { info.keywords = String(op.keywords); applied++; }
    if (applied === 0) throw new Error('set_metadata needs at least one of title, author, copyright, description, caption, keywords');
  }
};

/**
 * Handlers that do not need a document to exist yet. The dispatcher resolves the
 * target document before calling a handler, which would make it impossible to
 * open or create the very first document of a plan.
 */
HANDLERS.open.needsDocument = false;
HANDLERS.new_document.needsDocument = false;

function dshHandlerNames() {
  var names = [];
  for (var key in HANDLERS) { if (HANDLERS.hasOwnProperty(key)) names.push(key); }
  names.sort();
  return names;
}

/**
 * Run one plan against one document, recording what ran into the applied list.
 *
 * The doc argument may be null, in which case each operation resolves its own target
 * document — that is what lets a plan start by opening or creating one. Batch
 * runs pass the document they just opened instead.
 */
function dshApplyPlan(doc, ops, applied) {
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (op === null || typeof op !== 'object') throw new Error('operation ' + (i + 1) + ' is not an object');
    var name = op.op === undefined ? null : String(op.op);
    if (name === null) throw new Error('operation ' + (i + 1) + ' has no "op" field');
    var handler = HANDLERS[name];
    if (handler === undefined) throw new Error('unknown operation "' + name + '" (operation ' + (i + 1) + ')');
    var previous = DSH_CURRENT_OP;
    DSH_CURRENT_OP = { index: i, name: name };
    // No finally here on purpose: if the handler throws, the failing operation
    // must stay recorded so the report can name it.
    handler(op, handler.needsDocument === false ? null : (doc === null ? dshDocumentFor(op) : doc));
    DSH_CURRENT_OP = previous;
    applied.push(name);
  }
  return applied.length;
}

/**
 * Run a plan. Declared at the top level so suspendHistory can call it by name
 * from the script string it evaluates — that is what makes a whole plan a
 * single undo step.
 *
 * The started flag is set before the first operation, not after the last, so a
 * plan that fails halfway is never re-run by the caller's fallback path.
 */
function dshRunOps(ops) {
  DSH_RESULT.started = true;
  DSH_RESULT.applied = [];
  dshApplyPlan(null, ops, DSH_RESULT.applied);
  return DSH_RESULT.applied.length;
}

/**
 * Run the plan inside suspendHistory, so the whole thing collapses into one
 * undo step. Only possible with a document already open; the caller falls back
 * to a direct run when this returns false.
 */
function dshGroupAndRun(stepName, ops) {
  var doc = app.activeDocument;
  doc.suspendHistory(stepName, 'dshRunOps(' + dshJson(ops) + ');');
  return true;
}

var DSH_CURRENT_OP = null;
`

/**
 * Build the program that executes one plan.
 * @param params - `resultPath`, `ops`, optional `stepName`, `listOperations`.
 * @returns ExtendScript source.
 */
export function applyScript(params) {
  return `${prelude(params)}
${HANDLERS}
var out = { ok: true, tool: 'photoshop_apply' };
var previousDialogs = null;
try {
  previousDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  if (DSH.listOperations === true) {
    out.operations = dshHandlerNames();
  } else {
    var ops = DSH.ops;
    if (!(ops instanceof Array) || ops.length === 0) throw new Error('no operations were given');
    var stepName = DSH.stepName === undefined || DSH.stepName === null ? 'DeepSeek Harness' : String(DSH.stepName);

    var grouped = false;
    var canGroup = false;
    if (DSH.group !== false) {
      try { canGroup = app.documents.length > 0; } catch (countError) { canGroup = false; }
    }
    if (canGroup) {
      try { grouped = dshGroupAndRun(stepName, ops); }
      catch (groupError) {
        // A failure while grouping is either "grouping is not possible here" or
        // "an operation failed inside the group". The recorded current operation
        // tells them apart, and an operation failure has to become the plan's
        // failure rather than a footnote — otherwise a plan that stopped at
        // operation one is reported as having succeeded.
        if (DSH_CURRENT_OP !== null) throw groupError;
        out.groupError = String(groupError.message ? groupError.message : groupError);
      }
    }
    if (DSH_RESULT.started !== true) {
      // Grouping needs a document to hang the history state on, so a plan that
      // starts by opening one runs directly. A plan that failed midway has
      // already set the started flag, which stops it being applied twice.
      dshRunOps(ops);
      grouped = false;
    }
    out.grouped = grouped;
    out.applied = DSH_RESULT.applied;
    out.appliedCount = DSH_RESULT.applied.length;

    try {
      var doc = app.activeDocument;
      out.document = {
        name: String(doc.name),
        width: Math.round(doc.width.value),
        height: Math.round(doc.height.value),
        layers: doc.layers.length,
        saved: doc.saved === true
      };
    } catch (summaryError) { }
  }
} catch (error) {
  out.ok = false;
  out.error = String(error.message ? error.message : error);
  out.failedOp = DSH_CURRENT_OP;
  out.applied = DSH_RESULT.applied;
} finally {
  if (previousDialogs !== null) {
    try { app.displayDialogs = previousDialogs; } catch (restoreError) { }
  }
}
dshWrite(DSH.resultPath, out);
'PHOTOSHOP_APPLY_DONE'
`
}

/**
 * Build the program that applies one plan to many files.
 *
 * Each file is opened, run through the plan, saved to the caller's output path
 * and closed without saving, so an input file is never written to. A failure in
 * one file is recorded and the batch continues: a batch that stops at the first
 * bad frame is far less useful than one that reports which frames were bad.
 *
 * Progress and partial results are flushed after every file, so a timeout or a
 * cancellation still reports what was actually produced.
 * @param params - `resultPath`, `items` (input/output pairs), `ops`, and the
 *   save settings, plus optional `progressPath` / `cancelPath`.
 * @returns ExtendScript source.
 */
export function batchScript(params) {
  return `${prelude(params)}
${HANDLERS}
var out = { ok: true, tool: 'photoshop_batch', results: [], cancelled: false };
var previousDialogs = null;

function dshBatchOne(item, index) {
  var record = { index: index, input: item.input, output: item.output, ok: false, applied: [] };
  var doc = null;
  try {
    var source = new File(String(item.input));
    if (!source.exists) { record.error = 'input file not found'; return record; }
    doc = app.open(source);
    record.sourceWidth = Math.round(doc.width.value);
    record.sourceHeight = Math.round(doc.height.value);

    dshApplyPlan(doc, DSH.ops, record.applied);
    record.appliedCount = record.applied.length;

    if (item.output !== null && item.output !== undefined) {
      var target = dshSaveAs(doc, item.output, DSH.outputFormat,
        dshNumber(DSH.outputQuality, 'outputQuality', 10), DSH.overwrite === true);
      record.output = target.fsName.replace(/\\\\/g, '/');
      record.outputBytes = target.length;
    }
    record.width = Math.round(doc.width.value);
    record.height = Math.round(doc.height.value);
    record.ok = true;
  } catch (error) {
    record.error = String(error.message ? error.message : error);
    record.failedOp = DSH_CURRENT_OP;
    record.appliedCount = record.applied.length;
  } finally {
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
  var total = DSH.items.length;
  for (var index = 0; index < total; index++) {
    if (dshCancelled()) { out.cancelled = true; break; }
    var record = dshBatchOne(DSH.items[index], index);
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
'PHOTOSHOP_BATCH_DONE'
`
}
