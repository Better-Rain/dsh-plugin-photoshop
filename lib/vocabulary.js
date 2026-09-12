/**
 * dsh-plugin-photoshop — the operation vocabulary.
 *
 * One list, two uses. It is what `photoshop_apply` validates an incoming plan
 * against, and what `photoshop_reference` hands to the model on demand so the
 * standing prompt does not have to carry it.
 *
 * The implementations live in `lib/ops-jsx.js` as ExtendScript handlers. Names
 * appear in both files, so `test/e2e.mjs` asks Photoshop for its handler list and
 * asserts the two agree — drift between documentation and reality is a test
 * failure rather than a surprise at runtime.
 *
 * `params` is a short human-readable signature for the reference output; the
 * authoritative validation is in each handler, which rejects what it cannot use
 * with a message naming the operation.
 */

/** @typedef {{ name: string, summary: string, params: string }} Operation */

/** @type {Array<{ group: string, purpose: string, operations: Operation[] }>} */
export const VOCABULARY = [
  {
    group: 'document',
    purpose: 'Open, create, save and reshape the document itself.',
    operations: [
      { name: 'open', params: 'path', summary: 'Open a file and leave it open; becomes the active document.' },
      { name: 'new_document', params: 'width, height[, resolution, name, mode, fill]', summary: 'Create a new document.' },
      { name: 'close', params: '[document, save, discard]', summary: 'Close a document without saving unless save is true; refuses to discard unsaved changes unless discard is true.' },
      { name: 'save_as', params: 'path[, format, quality, overwrite]', summary: 'Write a copy to disk. format: png (default), jpeg, psd, tiff.' },
      { name: 'resize_image', params: '[width, height, max_side, resolution, resample]', summary: 'Resample the image. Give width+height, or max_side to cap the longest edge.' },
      { name: 'resize_canvas', params: 'width, height[, anchor]', summary: 'Change the canvas without resampling. anchor: top_left … bottom_right, center (default).' },
      { name: 'crop', params: 'left, top, right, bottom', summary: 'Crop to a rectangle in pixels.' },
      { name: 'rotate_canvas', params: 'angle', summary: 'Rotate the whole canvas by any angle in degrees.' },
      { name: 'flip_canvas', params: 'axis', summary: 'Flip the canvas: horizontal or vertical.' },
      { name: 'trim', params: '[based_on]', summary: 'Trim away edges. based_on: transparent (default) or top_left_pixel, bottom_right_pixel.' },
      { name: 'flatten', params: '', summary: 'Flatten all layers into one.' },
      { name: 'merge_visible', params: '', summary: 'Merge the visible layers, leaving hidden ones alone.' },
      { name: 'duplicate', params: '[name]', summary: 'Duplicate the document; the copy becomes active.' },
      { name: 'change_mode', params: 'mode', summary: 'Change the colour mode: rgb, grayscale, cmyk, lab, bitmap.' },
      { name: 'convert_profile', params: 'profile[, intent, black_point, dither]', summary: 'Convert to another colour profile.' },
      { name: 'export_layers', params: 'output_dir[, format, suffix, recursive, visible_only]', summary: 'Write every layer to its own file, each keeping the full canvas so the outputs line up. Original visibility is restored afterwards.' },
    ],
  },
  {
    group: 'layer',
    purpose: 'Create, arrange, name and modify layers, masks and layer styles.',
    operations: [
      { name: 'add_layer', params: '[name, above]', summary: 'Add an empty pixel layer.' },
      { name: 'add_group', params: '[name, above]', summary: 'Add an empty layer group (a layer set).' },
      { name: 'unlock_background', params: 'target', summary: 'Convert the background layer into an ordinary layer. Required before it can take a mask, a layer style, a move, or any opacity below 100.' },
      { name: 'delete_layer', params: 'target', summary: 'Delete a layer.' },
      { name: 'duplicate_layer', params: 'target[, name]', summary: 'Duplicate a layer.' },
      { name: 'rename_layer', params: 'target, name', summary: 'Rename a layer.' },
      { name: 'set_opacity', params: 'target, value', summary: 'Set layer opacity, 0–100.' },
      { name: 'set_fill_opacity', params: 'target, value', summary: 'Set fill opacity, 0–100 (leaves effects untouched).' },
      { name: 'set_blend_mode', params: 'target, mode', summary: 'Set the blend mode by name, e.g. multiply, screen, overlay.' },
      { name: 'set_visibility', params: 'target, visible', summary: 'Show or hide a layer.' },
      { name: 'set_lock', params: 'target, locked', summary: 'Lock or unlock all of a layer’s properties.' },
      { name: 'move_layer', params: 'target, into[, placement]', summary: 'Move a layer into a group, or next to another layer. placement: inside (default), before, after.' },
      { name: 'ungroup', params: 'target', summary: 'Dissolve a layer group, keeping its contents.' },
      { name: 'rasterize', params: 'target', summary: 'Rasterize a text, shape, fill or smart-object layer.' },
      { name: 'to_smart_object', params: 'target', summary: 'Convert a layer to a smart object.' },
      { name: 'merge_down', params: 'target', summary: 'Merge a layer into the one below it.' },
      { name: 'add_mask', params: 'target[, mode]', summary: 'Add a layer mask. mode: reveal_all (default), hide_all, from_selection (needs an active selection).' },
      { name: 'delete_mask', params: 'target', summary: 'Delete a layer mask without applying it.' },
      { name: 'apply_mask', params: 'target', summary: 'Bake a layer mask into the layer pixels.' },
      { name: 'invert_mask', params: 'target', summary: 'Invert a layer mask.' },
      { name: 'refine_mask', params: 'target, blur_px', summary: 'Soften a layer mask to give the cut edge a controllable falloff. The headless stand-in for Select and Mask, which cannot run without its workspace.' },
      { name: 'clipping_mask', params: 'target[, enabled]', summary: 'Make a layer clip to the one below, or release it.' },
      { name: 'layer_style', params: 'target, style[, …]', summary: 'Add a layer effect. style: drop_shadow, inner_shadow, outer_glow, inner_glow, stroke. Optional opacity, distance, size, angle, color, width.' },
    ],
  },
  {
    group: 'adjust',
    purpose: 'Tonal and colour adjustments, applied to a layer.',
    operations: [
      { name: 'levels', params: 'target[, input_black, input_white, gamma, output_black, output_white]', summary: 'Levels. Defaults 0, 255, 1, 0, 255.' },
      { name: 'brightness_contrast', params: 'target[, brightness, contrast]', summary: 'Brightness and contrast, −100…100 each.' },
      { name: 'hue_saturation', params: 'target[, hue, saturation, lightness]', summary: 'Hue/saturation. hue is degrees, saturation and lightness are −100…100.' },
      { name: 'vibrance', params: 'target[, vibrance, saturation]', summary: 'Vibrance and saturation, −100…100.' },
      { name: 'black_white', params: 'target', summary: 'Convert to black and white with Photoshop’s default mix.' },
      { name: 'desaturate', params: 'target', summary: 'Remove colour.' },
      { name: 'invert', params: 'target', summary: 'Invert the layer.' },
      { name: 'threshold', params: 'target[, level]', summary: 'Threshold at a level 1–255 (default 128).' },
      { name: 'posterize', params: 'target[, levels]', summary: 'Reduce to N levels 2–255 (default 8).' },
      { name: 'equalize', params: 'target', summary: 'Equalize the histogram.' },
      { name: 'auto_levels', params: 'target', summary: 'Photoshop’s Auto Levels.' },
      { name: 'auto_contrast', params: 'target', summary: 'Photoshop’s Auto Contrast.' },
    ],
  },
  {
    group: 'filter',
    purpose: 'Filters, applied to a layer.',
    operations: [
      { name: 'gaussian_blur', params: 'target, radius', summary: 'Gaussian blur in pixels.' },
      { name: 'motion_blur', params: 'target, angle, distance', summary: 'Motion blur.' },
      { name: 'radial_blur', params: 'target, amount[, method, quality]', summary: 'Radial blur. method: spin (default) or zoom.' },
      { name: 'smart_blur', params: 'target, radius, threshold[, quality, mode]', summary: 'Smart blur. quality: low, medium or high. mode: normal, edge_only or overlay_edge_only.' },
      { name: 'unsharp_mask', params: 'target, amount, radius, threshold', summary: 'Unsharp mask — the usual sharpening tool.' },
      { name: 'sharpen', params: 'target', summary: 'Sharpen.' },
      { name: 'sharpen_more', params: 'target', summary: 'Sharpen more.' },
      { name: 'sharpen_edges', params: 'target', summary: 'Sharpen edges only.' },
      { name: 'add_noise', params: 'target, amount[, distribution, monochromatic]', summary: 'Add noise. distribution: uniform (default) or gaussian.' },
      { name: 'dust_and_scratches', params: 'target, radius, threshold', summary: 'Dust and scratches.' },
      { name: 'median_noise', params: 'target, radius', summary: 'Median noise reduction.' },
      { name: 'despeckle', params: 'target', summary: 'Despeckle.' },
      { name: 'high_pass', params: 'target, radius', summary: 'High pass — for frequency separation.' },
      { name: 'maximum', params: 'target, radius', summary: 'Maximum (spread highlights).' },
      { name: 'minimum', params: 'target, radius', summary: 'Minimum (spread shadows).' },
      { name: 'offset', params: 'target, horizontal, vertical[, wrap]', summary: 'Offset the layer. wrap: wraparound (default) or repeat_edge.' },
      { name: 'custom_filter', params: 'target, kernel[, scale, offset]', summary: 'Custom convolution. kernel is 25 numbers (5×5).' },
      { name: 'pinch', params: 'target, amount', summary: 'Pinch distortion, −100…100.' },
      { name: 'spherize', params: 'target, amount[, mode]', summary: 'Spherize. mode: normal (default), horizontal_only, vertical_only.' },
      { name: 'twirl', params: 'target, angle', summary: 'Twirl distortion.' },
    ],
  },
  {
    group: 'select',
    purpose: 'Make, change, store and load selections.',
    operations: [
      { name: 'select_all', params: '', summary: 'Select the whole canvas.' },
      { name: 'deselect', params: '', summary: 'Clear the selection.' },
      { name: 'invert_selection', params: '', summary: 'Invert the current selection.' },
      { name: 'clear_selection', params: '', summary: 'Delete the selected pixels, leaving transparency — the Delete key.' },
      { name: 'select_subject', params: '', summary: 'Photoshop’s Select Subject — the AI subject selection.' },
      { name: 'select_sky', params: '', summary: 'Photoshop’s Select Sky.' },
      { name: 'remove_background', params: '', summary: 'Photoshop’s Remove Background, applied to the active layer.' },
      { name: 'expand', params: 'pixels', summary: 'Grow the selection.' },
      { name: 'contract', params: 'pixels', summary: 'Shrink the selection.' },
      { name: 'feather', params: 'pixels', summary: 'Soften the selection edge.' },
      { name: 'smooth', params: 'radius', summary: 'Smooth the selection outline.' },
      { name: 'border', params: 'pixels', summary: 'Replace the selection with a border of that width.' },
      { name: 'save_selection', params: 'name', summary: 'Store the selection as a named channel.' },
      { name: 'load_selection', params: 'name', summary: 'Load a selection from a named channel.' },
    ],
  },
  {
    group: 'paint',
    purpose: 'Text, fills and colour applied to the document.',
    operations: [
      { name: 'add_text', params: 'contents[, name, size, color, font, justification, x, y]', summary: 'Add a text layer.' },
      { name: 'set_text', params: 'target[, contents, size, color, font, justification]', summary: 'Change a text layer’s content or styling.' },
      { name: 'fill', params: 'color[, target, opacity, preserve_transparency]', summary: 'Fill the current selection, or the whole layer when nothing is selected. preserve_transparency defaults to false, so a brand-new empty layer does get filled.' },
      { name: 'add_color_layer', params: 'color[, name]', summary: 'Add a pixel layer filled completely with one colour.' },
    ],
  },
  {
    group: 'history',
    purpose: 'Move through the undo history.',
    operations: [
      { name: 'step_backward', params: '[steps]', summary: 'Undo N steps (default 1).' },
      { name: 'step_forward', params: '[steps]', summary: 'Redo N steps (default 1).' },
    ],
  },
  {
    group: 'action',
    purpose: 'The user’s own recorded actions, and what is in the Actions panel.',
    operations: [
      { name: 'list_actions', params: '', summary: 'List the action sets in the Actions panel and the actions in the currently targeted one. Read-only — playing an action is deliberately not offered, because a shipped action can open a dialog that a script cannot dismiss.' },
    ],
  },
  {
    group: 'metadata',
    purpose: 'Document metadata that travels with the file.',
    operations: [
      { name: 'set_metadata', params: '[title, author, copyright, description, caption, keywords]', summary: 'Set document metadata.' },
    ],
  },
]

/** Every operation name, in vocabulary order. */
export const OPERATION_NAMES = VOCABULARY.flatMap((section) => section.operations.map((operation) => operation.name))

/** Fast membership test for plan validation. */
export const OPERATION_NAME_SET = new Set(OPERATION_NAMES)

/**
 * Find one operation's metadata.
 * @param name - the operation name.
 * @returns its group and entry, or undefined.
 */
export function findOperation(name) {
  for (const section of VOCABULARY) {
    const operation = section.operations.find((entry) => entry.name === name)
    if (operation !== undefined) return { group: section.group, operation }
  }
  return undefined
}

/**
 * Suggest the closest operation names for a typo, so a failed plan explains
 * itself instead of just refusing.
 * @param name - the unknown operation name.
 * @param limit - how many suggestions to return.
 * @returns candidate names, best first.
 */
export function suggestOperations(name, limit = 5) {
  const needle = String(name).toLowerCase()
  const scored = OPERATION_NAMES.map((candidate) => {
    const haystack = candidate.toLowerCase()
    let score = 0
    if (haystack.includes(needle) || needle.includes(haystack)) score = 100 - Math.abs(haystack.length - needle.length)
    else {
      // Cheap similarity: shared prefix length plus shared characters.
      let prefix = 0
      while (prefix < needle.length && prefix < haystack.length && needle[prefix] === haystack[prefix]) prefix += 1
      const shared = new Set(needle.split('')).size
      const overlap = [...new Set(needle.split(''))].filter((character) => haystack.includes(character)).length
      score = prefix * 4 + overlap * 2 - Math.abs(haystack.length - needle.length) + shared * 0
    }
    return { candidate, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

/**
 * Render the vocabulary as the text `photoshop_reference` returns.
 * @param group - optional group name; omit for everything.
 * @returns the reference text.
 */
export function formatReference(group) {
  const sections = group === undefined
    ? VOCABULARY
    : VOCABULARY.filter((section) => section.group === group.toLowerCase())
  if (sections.length === 0) {
    return `Unknown group "${group}". Groups: ${VOCABULARY.map((section) => section.group).join(', ')}.`
  }
  const lines = []
  lines.push('photoshop_apply operations — pass them as the `ops` array, in order, each with an `op` field.')
  lines.push('')
  for (const section of sections) {
    lines.push(`## ${section.group} — ${section.purpose}`)
    const width = section.operations.reduce((most, operation) => Math.max(most, operation.name.length), 0)
    for (const operation of section.operations) {
      lines.push(`  ${operation.name.padEnd(width)}  ${operation.params}`)
      lines.push(`  ${' '.repeat(width)}  ${operation.summary}`)
    }
    lines.push('')
  }
  lines.push(`${OPERATION_NAMES.length} operations in total.`)
  lines.push('Anything not covered here is still reachable through photoshop_run_jsx.')
  return lines.join('\n')
}
