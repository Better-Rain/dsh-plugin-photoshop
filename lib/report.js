/**
 * dsh-plugin-photoshop — model-facing report formatting.
 *
 * Photoshop hands back JSON; the model and the user read text. These functions
 * turn one inspection result into a compact, aligned report in which every fact
 * an agent needs in order to act is present exactly once: what document is open,
 * what is selected, and what each layer is, what it is called, and what state it
 * is in.
 *
 * Layer identity is always printed twice — an index path (`0.1`) and a name path
 * (`Header/Title`) — because the user says the second and later operations are
 * easier to address with the first.
 */

/** Photoshop reports paths as file URIs; make them readable again. */
function readablePath(value) {
  const text = String(value)
  try {
    return decodeURIComponent(text).replace(/^\/([a-zA-Z])\//, (_match, drive) => `${drive.toUpperCase()}:/`)
  } catch {
    return text
  }
}

/** Human wording for a layer's kind, falling back to the raw type. */
function layerKindOf(layer) {
  if (layer.kind !== undefined) return String(layer.kind).toLowerCase()
  if (layer.type === 'LayerSet') return 'group'
  return String(layer.type ?? 'layer').toLowerCase()
}

/** The state flags worth knowing before touching a layer, in reading order. */
function layerFlags(layer) {
  const flags = []
  flags.push(layer.visible === false ? 'hidden' : 'visible')
  if (typeof layer.opacity === 'number' && layer.opacity !== 100) flags.push(`opacity ${layer.opacity}%`)
  if (typeof layer.fillOpacity === 'number' && layer.fillOpacity !== 100) flags.push(`fill ${layer.fillOpacity}%`)
  if (typeof layer.blendMode === 'string' && layer.blendMode.toUpperCase() !== 'NORMAL') {
    flags.push(String(layer.blendMode).toLowerCase())
  }
  if (layer.clipping === true) flags.push('clipping')
  if (layer.mask === true) flags.push(layer.maskEnabled === false ? 'mask (disabled)' : 'mask')
  if (layer.vectorMask === true) flags.push('vector mask')
  if (layer.effects === true) flags.push('layer effects')
  if (layer.isBackground === true) flags.push('background')
  if (layer.allLocked === true) flags.push('locked')
  return flags.join(' · ')
}

/** Layer-specific detail: text content, child count, bounds. */
function layerDetail(layer) {
  const parts = []
  if (layer.kind === 'TEXT') {
    const content = typeof layer.text === 'string' ? layer.text.replace(/\s+/g, ' ').trim() : ''
    const shown = content.length > 60 ? `${content.slice(0, 57)}...` : content
    parts.push(`text ${JSON.stringify(shown)}`)
    if (typeof layer.textSize === 'number') parts.push(`${layer.textSize}px`)
    if (typeof layer.font === 'string' && layer.font !== '') parts.push(layer.font)
    if (typeof layer.justification === 'string' && layer.justification !== null) {
      parts.push(String(layer.justification).toLowerCase())
    }
  }
  if (typeof layer.children === 'number') parts.push(`${layer.children} child${layer.children === 1 ? '' : 'ren'}`)
  if (typeof layer.bounds === 'object' && layer.bounds !== null && Array.isArray(layer.bounds)) {
    parts.push(`bounds ${layer.bounds.join(',')}`)
  }
  return parts.join(' · ')
}

/**
 * Render one `photoshop_inspect` result.
 * @param result - the parsed recipe output.
 * @returns the report text.
 */
export function formatInspectReport(result) {
  if (result === undefined) return 'Photoshop returned no inspection data.'
  if (result.ok === false) {
    const open = Array.isArray(result.openDocuments) && result.openDocuments.length > 0
      ? ` Open documents: ${result.openDocuments.join(', ')}.`
      : ''
    return `Could not inspect: ${result.error ?? 'unknown error'}.${open}`
  }

  const lines = []
  const openDocuments = Array.isArray(result.openDocuments) ? result.openDocuments : []
  lines.push(
    `Adobe Photoshop ${result.photoshop?.version ?? '?'} — ${openDocuments.length} document${openDocuments.length === 1 ? '' : 's'} open${openDocuments.length > 0 ? `: ${openDocuments.join(', ')}` : ''}`,
  )

  const document = result.document
  if (document === undefined || document === null) {
    lines.push('No document is open, so there is nothing to inspect.')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`Document "${document.name}" — ${document.width}x${document.height} px @ ${document.resolution} ppi`)
  lines.push(`  mode      ${document.mode}, ${document.bitsPerChannel} bit/channel, profile ${document.colorProfile}`)
  if (document.path !== undefined) lines.push(`  path      ${readablePath(document.path)}`)
  lines.push(`  saved     ${document.saved === true ? 'yes' : 'no — there are unsaved changes'}`)
  if (document.activeLayer !== undefined) lines.push(`  active    layer "${document.activeLayer}"`)
  if (document.selection === null || document.selection === undefined) {
    lines.push('  selection none')
  } else {
    lines.push(`  selection bounds ${document.selection.join(',')}`)
  }
  if (document.history !== undefined) {
    lines.push(`  history   ${document.history.states} states, current "${document.history.current}"`)
  }
  const counts = []
  if (typeof document.channels === 'number') counts.push(`${document.channels} channels`)
  if (typeof document.pathItems === 'number') counts.push(`${document.pathItems} paths`)
  if (typeof document.guides === 'number') counts.push(`${document.guides} guides`)
  if (counts.length > 0) lines.push(`  contains  ${counts.join(', ')}`)

  const layers = Array.isArray(result.layers) ? result.layers : []
  lines.push('')
  if (layers.length === 0) {
    lines.push('Layers: none reported.')
    return lines.join('\n')
  }
  lines.push(`Layers (${layers.length}${result.truncated === true ? ', truncated' : ''}, top to bottom):`)

  const rows = layers.map((layer) => ({
    path: String(layer.path ?? '?'),
    kind: layerKindOf(layer),
    name: `"${layer.name ?? '?'}"`,
    flags: layerFlags(layer),
    detail: layerDetail(layer),
  }))
  const width = (key) => rows.reduce((most, row) => Math.max(most, row[key].length), 0)
  const pathWidth = width('path')
  const kindWidth = width('kind')
  const nameWidth = width('name')
  for (const row of rows) {
    const head = `  ${row.path.padEnd(pathWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.name.padEnd(nameWidth)}`
    lines.push(`${head}  ${row.flags}${row.detail === '' ? '' : `  — ${row.detail}`}`)
  }
  lines.push('')
  lines.push('Address a layer either by its index path (0.1 = the second layer inside the first group) or by its name path (Header/Title).')
  return lines.join('\n')
}
