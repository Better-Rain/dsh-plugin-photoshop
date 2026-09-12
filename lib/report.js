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

/**
 * Render one `photoshop_apply` result.
 * @param result - the parsed recipe output.
 * @param plan - the operations that were sent, for a denominator on failure.
 * @returns the report text.
 */
export function formatApplyReport(result, plan) {
  if (result === undefined) return 'Photoshop returned no result for this plan.'
  const applied = Array.isArray(result.applied) ? result.applied : []
  const total = Array.isArray(plan) ? plan.length : applied.length
  const lines = []

  if (result.ok === true) {
    if (applied.length === 0) {
      return `Photoshop reported success but recorded no applied operation${result.groupError !== undefined ? ` (${result.groupError})` : ''}. That means the plan never reached the document — run photoshop_status and retry.`
    }
    lines.push(
      `Applied ${applied.length} operation${applied.length === 1 ? '' : 's'}${result.grouped === true ? ' in a single undo step' : ''}:`,
    )
    applied.forEach((name, index) => lines.push(`  ${index + 1}. ${name}`))
    if (result.grouped !== true) {
      lines.push(
        result.groupError !== undefined
          ? `note: this plan could not be wrapped in one undo step (${result.groupError}), so each operation is its own history state.`
          : 'note: this plan ran outside an undo group, so each operation is its own history state.',
      )
    }
    if (result.document !== undefined) {
      const document = result.document
      lines.push(
        `Document now: "${document.name}" — ${document.width}x${document.height} px, ${document.layers} layer${document.layers === 1 ? '' : 's'}, ${document.saved === true ? 'saved' : 'unsaved changes'}`,
      )
    }
    if (Array.isArray(result.notes) && result.notes.length > 0) {
      for (const note of result.notes) lines.push(`  ${note}`)
    }
    return lines.join('\n')
  }

  const failed = result.failedOp
  lines.push(
    `Operation ${failed !== undefined && failed !== null ? failed.index + 1 : '?'}${failed !== undefined && failed !== null ? ` (${failed.name})` : ''} failed after ${applied.length} of ${total} operation${total === 1 ? '' : 's'}.`,
  )
  if (result.error !== undefined) lines.push(`  ${result.error}`)
  if (applied.length > 0) {
    lines.push(`  already applied: ${applied.join(', ')}`)
    lines.push(
      result.grouped === true
        ? '  the plan is one undo step, so a single undo reverts all of it.'
        : '  undo to revert what was applied.',
    )
  } else {
    lines.push('  nothing was applied — the document is unchanged.')
  }
  return lines.join('\n')
}

/**
 * Render one `photoshop_batch` result.
 * @param result - the parsed recipe output.
 * @param plan - the operations each file was run through.
 * @param summary - counts the caller already knows (queued, skipped).
 * @returns the report text.
 */
export function formatBatchReport(result, plan, summary = {}) {
  if (result === undefined) return 'Photoshop returned no batch result.'
  const records = Array.isArray(result.results) ? result.results : []
  const operations = Array.isArray(plan) ? plan.length : 0
  const lines = []

  const planned = summary.queued ?? records.length
  lines.push(
    `Photoshop batch — ${planned} file${planned === 1 ? '' : 's'}, ${operations} operation${operations === 1 ? '' : 's'} each`,
  )
  if (summary.outputDir !== undefined) {
    lines.push(`output: ${summary.outputDir}${summary.format !== undefined ? ` (${summary.format})` : ''}`)
  }
  if (result.ok === false && result.error !== undefined) lines.push(`bridge: ${result.error}`)
  if (result.cancelled === true) lines.push('cancelled early; the files listed below were already finished')
  if (records.length < planned) {
    lines.push(`only ${records.length} of ${planned} file(s) were reached — Photoshop stopped early`)
  }

  const succeeded = records.filter((record) => record.ok === true)
  const failed = records.filter((record) => record.ok !== true)
  const opaque = succeeded.filter((record) => record.hasAlpha === false)
  lines.push(
    `succeeded ${succeeded.length}, failed ${failed.length}${summary.skipped > 0 ? `, skipped ${summary.skipped}` : ''}`,
  )

  for (const record of records.slice(0, REPORT_ITEM_LIMIT)) {
    const name = String(record.input ?? '?').split(/[\\/]/).pop()
    const outputName = record.output === undefined || record.output === null ? '(not saved)' : String(record.output).split(/[\\/]/).pop()
    if (record.ok === true) {
      const size = record.width !== undefined ? `${record.width}x${record.height}` : '?'
      const source = record.sourceWidth !== undefined ? `${record.sourceWidth}x${record.sourceHeight} -> ` : ''
      const alpha = record.hasAlpha === true ? 'alpha' : record.hasAlpha === false ? 'NO ALPHA' : 'unchecked'
      const edge = typeof record.edge === 'string' && record.edge !== '' ? `, ${record.edge}` : ''
      const ops = `${record.appliedCount ?? 0}/${operations} ops`
      lines.push(`[ok]   ${name} -> ${outputName}  ${source}${size} (${alpha}${edge})  ${ops}`)
    } else {
      const at = record.failedOp
      const where = at !== undefined && at !== null ? `operation ${at.index + 1} (${at.name}): ` : ''
      const done = (record.appliedCount ?? 0) > 0 ? ` [${record.appliedCount} operation(s) had already been applied]` : ''
      lines.push(`[FAIL] ${name}: ${where}${record.error ?? 'unknown error'}${done}`)
    }
  }
  if (records.length > REPORT_ITEM_LIMIT) lines.push(`...and ${records.length - REPORT_ITEM_LIMIT} more`)
  if (opaque.length > 0) {
    lines.push(`warning: ${opaque.length} output(s) have no alpha channel — no part of the plan produced transparency.`)
  }
  if (Array.isArray(summary.missing) && summary.missing.length > 0) {
    lines.push(`note: these input paths did not exist: ${summary.missing.join(', ')}`)
  }
  if (Array.isArray(summary.skippedItems) && summary.skippedItems.length > 0) {
    for (const entry of summary.skippedItems.slice(0, REPORT_ITEM_LIMIT)) {
      lines.push(`[skip] ${String(entry.input).split(/[\\/]/).pop()}: ${entry.reason}`)
    }
  }
  if (Array.isArray(result.notes) && result.notes.length > 0) {
    for (const note of result.notes) lines.push(`  ${note}`)
  }
  return lines.join('\n')
}

/**
 * Render one dry-run result: what each operation would touch, without touching it.
 * @param result - the parsed recipe output.
 * @param plan - the operations that were examined.
 * @returns the report text.
 */
export function formatDryRunReport(result, plan) {
  if (result === undefined) return 'Photoshop returned no dry-run result.'
  if (result.ok === false) return `Could not examine the plan: ${result.error ?? 'unknown error'}`
  const steps = Array.isArray(result.steps) ? result.steps : []
  const total = Array.isArray(plan) ? plan.length : steps.length
  const lines = [`Dry run — ${total} operation${total === 1 ? '' : 's'}, nothing applied`]
  const width = String(steps.length).length
  for (const step of steps) {
    const label = `${String(step.index + 1).padStart(width)}. ${String(step.name).padEnd(20)}`
    if (step.ok === true) {
      const detail = step.note !== undefined ? step.note : (step.resolved ?? []).join('; ')
      lines.push(`  ${label} ok    ${detail}`)
    } else {
      lines.push(`  ${label} FAIL  ${step.error ?? 'unknown error'}`)
    }
  }
  if (steps.length < total) lines.push(`  only ${steps.length} of ${total} operation(s) were examined`)
  const failed = steps.filter((step) => step.ok !== true)
  lines.push('')
  lines.push(
    failed.length === 0
      ? 'Every operation resolves against the current state, and nothing was changed. Remove dry_run to actually run it.'
      : `${failed.length} operation(s) name something that does not exist. Fix those before running the plan for real.`,
  )
  return lines.join('\n')
}

/** Photoshop reports paths as file URIs; make them readable again. */
function readablePath(value) {
  const text = String(value)
  try {
    return decodeURIComponent(text).replace(/^\/([a-zA-Z])\//, (_match, drive) => `${drive.toUpperCase()}:/`)
  } catch {
    return text
  }
}

/** How many per-item lines a report spells out before summarising the rest. */
export const REPORT_ITEM_LIMIT = 40

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
