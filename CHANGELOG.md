# Changelog

## 1.5.0

- **Edge quality can be measured now.** `lib/png.js` decodes a PNG far enough to
  count its alpha structure — fully transparent, fully opaque, and *partly*
  transparent pixels — by inflating the data with Node's zlib and undoing the
  per-scanline filters. The partial count is the width of the soft band along the
  outline, so "the edges look better" is a number rather than an opinion. Still
  zero dependencies.
- **Cutout refinement.** The `select-subject` path now builds a layer mask instead
  of inverting and clearing the selection, because a mask keeps the selection's
  anti-aliasing and can be refined afterwards. `photoshop_cutout` gained
  `contract_px` (shrink the selection to drop the rim of background the subject
  sat on — the stand-in for Photoshop's Matting menu, which is not scriptable
  here) and `mask_blur_px` (blur the mask itself). On the same input,
  `feather_px: 2, contract_px: 1, mask_blur_px: 1` takes the soft band from 1,271
  partial pixels (0.75%) to 12,637 (7.36%).
- **`refine_mask`** — soften a layer mask, through the mask channel. This is the
  only controllable headless edge tool this Photoshop offers: blurring a mask
  works while the mask is the active channel, but `adjustLevels` on a selected
  mask channel fails, so the usual "blur then re-tighten with Levels" step is not
  available.
- Cutout and batch reports now say whether each output has a hard or soft edge,
  and how many partial pixels make it up.

Unavailable on this build, established by execution and therefore **not**
promised: `defringe`, `removeWhiteMatte`, `removeBlackMatte` and
`colorDecontaminate` — the whole Layer > Matting menu plus Select and Mask's
colour decontamination.

## 1.4.0

- **`export_layers`** — write every layer of a document to its own file. Each
  layer is revealed on its own and saved, so the outputs keep the full canvas and
  line up with each other, and every layer's original visibility is restored
  afterwards, including when something fails.
- **`list_actions`** — read the Actions panel: the sets, and the actions in the
  currently targeted one. Photoshop exposes sets by index and one set's actions by
  a reference chained through that index, but the chained form answers with a
  synthesised label rather than the action's real name, so the usable names come
  from the unchained form.
- **Playing an action is deliberately not offered**, and the reason is recorded in
  `docs/ROADMAP.md`. A recorded action can open a dialog, `DialogModes.NO` does
  not suppress it, and a call blocked behind a modal cannot be cancelled from the
  plugin's side — every later call is refused until a human clicks. `list_actions`
  documents this in its own summary, and the `photoshop` skill tells the agent to
  ask the user to run the action instead.
- **The bridge now retries on `RPC_E_SERVERCALL_RETRYLATER` for two minutes.**
  Photoshop refuses COM calls with that while it is busy — mid-filter, with a
  dialog up, or because the user is working in it — and it means "ask again
  shortly", not "failed". The `PHOTOSHOP_BUSY` message now names the real cause
  and the real remedy rather than looking like a plugin defect.
- Operation plans pre-create any directory an operation declares through
  `output_dir`, because ExtendScript's `Folder` does not reliably offer a way to
  create one.
- Plans can report notes now (`export_layers` says what it wrote and where), and
  those notes appear in the report.

## 1.3.0

- **`photoshop_batch`** — apply one operation plan to many files inside a single
  Photoshop session. Each file is opened, run through the plan, saved to the
  batch output directory and closed without saving, so inputs are never written
  to. A failure on one file is recorded and the batch carries on. Plans may not
  contain `open`, `new_document`, `close` or `save_as`, because the batch owns
  those steps; including one is refused with the reason, and `save_as` especially
  so, since it would make every input write to the same path.
- **The `photoshop` skill** — registered with `ctx.skills.register`, so the
  working knowledge (call order, layer addressing, the safety rules, and this
  installation's quirks) is loaded on demand instead of inflating every session's
  prompt. The standing prompt section now just points at it.
- Batch output formats: png (default, the only one that keeps transparency),
  jpeg, psd and tiff. Photoshop normalises some extensions — asking for "jpeg"
  produces ".jpg" — so output names are derived from the extension it actually
  writes, and the save verification accepts either spelling.
- `save_as` and batch auto-save now share one implementation, so both accept the
  same formats and refuse the same things.

## 1.2.0

- **`photoshop_apply`** — run a plan of named operations against the open
  documents: 89 operations across document, layer, adjust, filter, select, paint,
  history and metadata. One Photoshop session per plan, wrapped in a single undo
  step when a document is already open, with the plan validated locally before
  Photoshop is touched and a failure report that names the failing operation,
  what was already applied, and whether one undo reverts all of it.
- **`photoshop_reference`** — return the operation vocabulary on demand, so the
  standing prompt stays small while the model can still learn every operation.
- `photoshop_cutout`'s recipe now also backs `select_subject`, `select_sky` and
  `remove_background` as individual operations.
- `test/e2e.mjs` verifies the whole vocabulary: it asks Photoshop for its compiled
  handler list and asserts it matches the documentation, then applies 102
  operations across seven plans, and runs a fixture check that every fact
  `photoshop_inspect` reports is real.

Findings from this build, all of which shaped the handlers:

- Photoshop's DOM layer methods act on the **selected** layer rather than the
  object they were called on, so every targeted operation selects its target
  first. Targeting a layer therefore makes it active.
- `eval` does not see Photoshop's global host objects inside the script string
  `suspendHistory` evaluates; enum tables are resolved once at load time instead.
- `RGB` exists in both `ChangeMode` and `NewDocumentMode` and they are not
  interchangeable — passing one for the other is a bare "invalid enumeration
  value".
- Fill's `preserve transparency` defaults to **off**: on a new transparent layer,
  preserving transparency fills nothing, which reads as success until a later
  operation reports "the current layer is empty".
- ActionManager cannot create a content or adjustment layer on this build, so
  `add_color_layer` produces the same pixels through the DOM instead of promising
  a live fill layer.
- Releasing a clipping mask has no working command; the layer's own read-write
  `grouped` property does it.
- `applySmartBlur` requires four arguments, and radial blur and smart blur have
  separate, non-interchangeable quality enumerations.
- A failure raised inside `suspendHistory` originally left the plan reported as
  successful with nothing applied; the recorded current operation now
  distinguishes an operation failure from grouping being unavailable.

## 1.1.0

- **`photoshop_inspect`** — read what is on screen before changing it. Reports every
  open document plus one document's size, resolution, colour mode, bit depth,
  colour profile, path, unsaved state, active layer, selection bounds, history
  position and channel/path/guide counts, then the complete layer tree with each
  layer's index path, name path, kind, visibility, opacity, fill opacity, blend
  mode, clipping, mask, vector mask, layer effects, background flag, bounds — and
  text content, size, font and justification for text layers. Read-only.

  Mask and layer-effect presence have no DOM property, so they come from an
  `executeActionGet` lookup keyed by layer id; building the reference from an id
  never changes the active layer, which is what keeps the inspection passive.

- `docs/ROADMAP.md` — the capability inventory and phased plan, grounded in two
  probes run against the installed Photoshop rather than a reference manual:
  - `test/probe-capabilities.mjs` uses ExtendScript reflection to enumerate the
    real API surface (`app` 29/44, `document` 42/26, `layer` 28/70,
    `selection` 5/25) and resolves an ActionManager catalogue. All 186 catalogue
    names resolve, which proves resolution is not a capability signal:
    `selectSubject` resolves and then refuses to execute, while `autoCutout` works.
  - `test/probe-operations.mjs` attempts every candidate operation for real, one
    scratch document each. `test/probe-operations-fix.mjs` re-attempts the
    failures with corrected recipes and confirms 14 more, which established that
    most first-round failures were our recipes rather than Photoshop's limits.

- Recipe findings now encoded in the roadmap: layer masks need `UsrM`=`RvlA`
  (reveal all, no selection) or `RvlS` (reveal selection, which requires one);
  layer styles and masks require an unlocked background layer; `LayerKind` may
  only be set to `TEXT` or `NORMAL`, so adjustment and fill layers must be built
  with ActionManager; `applyCustomFilter` wants a 5×5 kernel.

## 1.0.0

First release.

- `photoshop_status` — read-only report of the local Photoshop installation: version, build, open documents, and whether Select Subject / Remove Background exist in that version.
- `photoshop_cutout` — batch cutout through a single Photoshop session, with `select-subject` and `remove-background` modes, optional transparent-margin trim, feathering, max-side downscale, and per-output alpha verification from the PNG header.
- `photoshop_run_jsx` — run arbitrary ExtendScript and return its value, so Photoshop work without a dedicated tool is still reachable.

Implementation notes:

- Windows-only bridge: Node → `powershell.exe` → `New-Object -ComObject Photoshop.Application` → `DoJavaScript`.
- Zero runtime dependencies; nothing outside Node's standard library is imported.
- Parameters cross into ExtendScript as a JSON object literal (JSON being a subset of JavaScript literals), and results cross back through a UTF-8 file rather than the console.
- `app.displayDialogs` is forced to `DialogModes.NO` for the duration of every script and restored afterwards, so a modal alert can never block automation and the user's preference is left untouched.
- Only documents the plugin opened itself are closed, always without saving; inputs are never written to.
