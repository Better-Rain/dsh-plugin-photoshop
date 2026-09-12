/**
 * dsh-plugin-photoshop — the skill this plugin registers.
 *
 * The operation vocabulary is discoverable through `photoshop_reference`, but
 * knowing which operation to reach for, in what order, and which of this
 * build's quirks will bite is a different kind of knowledge. That is what a
 * skill is for: `ctx.skills.register` publishes it as a normal skill, so it is
 * routed by its description and loaded on demand instead of inflating every
 * session's prompt.
 *
 * Everything here was established by running against a real Photoshop and is
 * kept honest by `test/e2e.mjs`.
 */

export const SKILL_NAME = 'photoshop'

/** Markdown body, loaded only when the skill is actually invoked. */
const CONTENT = `# Operating the user's Photoshop

You drive the user's own Adobe Photoshop through this plugin. It is not a
sandboxed image library — every call reaches a real application on a real
desktop, so the rules below are about not damaging the user's work.

## Order of operations

1. **\`photoshop_inspect\` before naming anything.** Almost every request is
   relative to something already open ("make the background layer blue",
   "export every layer in that group"). Guessing at layer names is the single
   biggest source of unreliability. Inspect first, then act.
2. **\`photoshop_apply\` for the work.** One plan, in execution order.
3. **\`photoshop_cutout\` when the job is "cut the subject out".** It is
   purpose-built, batches inside one Photoshop session, and verifies that each
   output really carries an alpha channel.
4. **\`photoshop_batch\` when the same change applies to many files.**
5. **\`photoshop_status\` when something fails for no visible reason.**
6. **\`photoshop_run_jsx\` only when nothing else covers the task.** Prefer the
   vocabulary: its operations validate their inputs and report failures usefully.

## Addressing layers

\`photoshop_inspect\` prints both an index path (\`0.1\`) and a name path
(\`Header/Title\`) for every layer.

- Use the **name path** when the user named the layer out loud.
- Use the **index path** when a name is ambiguous — the tool says so and lists
  the candidates rather than guessing.

## Rules that keep the user's work safe

- **Dry-run a plan that names layers.** \`photoshop_apply\` with \`dry_run: true\`
  resolves every layer reference and reports what would be touched without
  touching it. When you have just written a plan that mentions layer names, this
  is one call that turns a guess into a fact.
- **Never write to an input file.** Operations write only where you point them.
  A batch closes each file without saving, always.
- **Only documents this plugin opened get closed.** Files the user has open are
  reported by \`photoshop_inspect\` and otherwise left alone.
- **Closing with unsaved changes needs explicit consent.** \`close\` refuses
  unless you pass \`discard: true\` or \`save: true\`.
- **A plan is one undo step.** When a document is already open the whole plan
  collapses into a single history entry, so the user can revert everything you
  did with one Ctrl+Z. Say so when you report back — it is the difference
  between "the agent changed my file" and "the agent changed my file and I can
  take it back".
- **Targeting a layer makes it active.** Photoshop's DOM layer methods act on
  the *selected* layer, so the plugin selects the target first. That is visible
  to the user and to a later \`photoshop_inspect\`.

## Quirks of this build, learned the hard way

- **A new layer is fully transparent.** \`fill\` therefore defaults to
  \`preserve_transparency: false\`; leaving it on fills nothing at all and the
  emptiness only surfaces later as "the current layer is empty".
- **A background layer is locked.** Opacity below 100, a layer mask, a layer
  style or a move all need \`unlock_background\` first. The tools say so when you
  forget.
- **Groups cannot be filled.** Target a pixel layer.
- **\`Select and Mask\` / \`Refine Edge\` is a modal workspace and cannot run
  headless.** For a softer cut, compose it: \`select_subject\`, then
  \`feather\`, or \`expand\`/\`contract\`/\`smooth\`, then \`add_mask\` with
  \`mode: from_selection\`.
- **Not available on this installation**: \`selectFocusArea\`,
  \`cameraRawFilter\`, \`neuralFilters\`, \`generativeFill\`, and creating a live
  Solid Color fill layer or adjustment layer by script. \`add_color_layer\`
  produces the pixels without the live swatch — do not promise the user an
  editable fill layer.
- **Never run an action.** \`list_actions\` can show you what is in the Actions
  panel, but playing one is deliberately not offered. A recorded action can open
  a dialog, and \`DialogModes.NO\` does not suppress it: the call then blocks
  forever, and the timeout only stops *our* side while Photoshop keeps waiting for
  a click that no script can deliver. If a request needs one of the user's
  actions, ask them to run it and tell you the result, or rebuild it from the
  operation vocabulary.
- **Formats that survive a round trip**: png, jpeg, psd, tiff. Transparency
  only survives png.
- **\`export_layers\` writes full-canvas files**, one per layer, all lined up with
  each other, and restores the original visibility afterwards.

## Recipes worth knowing

**Soft-edged cutout**
\`\`\`
select_subject → contract (pixels: 1) → feather (pixels: 2) → unlock_background →
add_mask (mode: from_selection) → refine_mask (blur_px: 1) →
trim (based_on: transparent) → save_as
\`\`\`

For \`photoshop_cutout\` the same thing is one call: \`contract_px: 1,
feather_px: 2, mask_blur_px: 1\`. Reach for \`contract_px\` whenever the subject
was shot against a plain background — it removes the coloured rim that would
otherwise travel with the cutout. Photoshop's Matting menu, the usual tool for
that rim, cannot be scripted here.

**Batch resize and convert**

\`\`\`
photoshop_batch {
  paths: ["D:/frames"],
  ops: [{ op: "resize_image", max_side: 1600 }],
  output_dir: "D:/out",
  output_format: "jpeg"
}
\`\`\`

Batch plans must not contain \`open\`, \`new_document\`, \`close\` or \`save_as\` —
the batch opens, saves and closes each file itself. It will tell you if you
include one.

**Non-destructive-looking edit with one undo**
\`\`\`
Apply the whole plan in one call. Do not split it across calls if the user
should be able to revert it as one action.
\`\`\`

**Ask before destroying.** Deleting layers, flattening, changing the colour
mode, and cropping all discard information. When a request is ambiguous about
which layers to keep, inspect and confirm rather than guessing.

## Reporting back

Say what changed in the user's terms — layer names, sizes, file paths, how many
images — and mention that one undo reverts the group. If something failed, give
the operation name, the reason, and what had already been applied.
`

/** The registration payload for \`ctx.skills.register\`. */
export const SKILL = {
  name: SKILL_NAME,
  description:
    'Drive the user\'s local Adobe Photoshop: inspect what is open, apply named operations (layers, masks, adjustments, filters, selections, text), batch-process files, and cut subjects out to transparent PNGs.',
  whenToUse:
    'Use when a task involves Photoshop — editing, retouching, resizing, converting, cutting out subjects, or any layered image work on the user\'s own files.',
  source: { kind: 'opaque', description: 'registered by dsh-plugin-photoshop' },
  content: CONTENT,
}
