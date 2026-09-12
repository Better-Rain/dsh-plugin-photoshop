# Changelog

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
