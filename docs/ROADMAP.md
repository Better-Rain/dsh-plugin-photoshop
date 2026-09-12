# Roadmap

Goal: **one sentence lets the agent operate Photoshop.** Everything below is
ordered so that each phase leaves the plugin more useful than the last, and no
phase depends on a later one.

## How this plan was grounded

Nothing here is copied from a reference manual. Two probes run against the
installed Photoshop establish what this build can actually do:

- `test/probe-capabilities.mjs` — ExtendScript reflection. `app.reflect.properties`
  and `.methods` enumerate the authoritative API surface of the *installed*
  version, so a member documented by Adobe but pruned in 2026 shows up as absent.
  It also resolves an ActionManager catalogue.
- `test/probe-operations.mjs` — execution matrix. Every candidate operation is
  attempted for real, each on its own scratch document.

Two findings shaped the whole plan:

1. **A resolved ActionManager id proves nothing.** Photoshop 2026 resolves all
   186 catalogue names, including `selectSubject` (4561) — which then refuses to
   execute with *command not currently available*, while `autoCutout` (496) works
   fine. Capability therefore comes from execution results only.
2. **Most first-round failures were our recipes, not Photoshop's limits.** Wrong
   event names (`groupLayers` vs `groupLayersEvent`), masks and layer styles
   attempted on a locked background layer, a 9-value kernel where 25 are wanted,
   text built through a descriptor where `LayerKind.TEXT` already exists. The
   corrected round-2 recipes moved 14 of those into the verified column.

### Verified API surface (reflection)

| Object | Properties | Methods |
| --- | --- | --- |
| `app` | 29 | 44 |
| `document` | 42 | 26 |
| `layer` | 28 | **70** |
| `selection` | 5 | 25 |

`selection.refineEdge` and `selection.selectAndMask` do **not** exist — edge
refinement is a modal workspace, so headless refinement has to be assembled from
`feather` / `expand` / `contract` / `smooth` / `selectBorder`.

### Verified operations (execution)

**Working — confirmed by execution**

| Area | Operations |
| --- | --- |
| AI selection | `autoCutout` (Select Subject), `removeBackground`, `selectSky` |
| Selection | `colorRange`, `selectBorder`, channel store/load, `makeWorkPath`, `invert`, `feather`, `clear` |
| Content-aware | Content-Aware Fill via `fill` + `contentAware` mode |
| Layer masks | `make` + `Nw `=`Chnl` + `UsrM`=`RvlA` (reveal all, no selection needed) or `UsrM`=`RvlS` (reveal selection, which *requires* an active selection) |
| Document | `crop`, `resizeCanvas`, `resizeImage`, `changeMode`, `convertProfile`, `trim` (transparent), `flatten`, `mergeVisibleLayers`, `duplicate`, `suspendHistory`, XMP read/write |
| Layers | `groupLayersEvent`, `ungroupLayersEvent`, clipping mask, convert to smart object, rasterize, duplicate, translate, rotate, resize, remove, blend mode, opacity |
| Layer styles | drop shadow, stroke (on an unlocked layer) |
| Text | create via `LayerKind.TEXT`, edit contents / size / colour / justification, point position |
| Adjustments | `adjustLevels`, `hueSaturation`, `vibrance`, `blackAndWhite` |
| Filters | `applyGaussianBlur`, `applyMotionBlur`, `applyRadialBlur`, `applyUnSharpMask`, `applyPinch`, `applySpherize`, `applyCustomFilter` (5×5 kernel) |
| History | step backward / forward, `suspendHistory` grouping |
| Saving | `saveAs` PNG / JPEG / PSD, `exportDocument` + Save-for-Web PNG |
| App | `featureEnabled`, custom-options round trip |

**Correct recipe still to be finalised — implementation-phase work**

| Operation | What round 2 established |
| --- | --- |
| Adjustment layers | `layer.kind` accepts **only** `TEXT` and `NORMAL`, so Levels/Curves/Hue-Sat/Gradient Map layers must be built with `make` + `adjustmentLayer`. |
| Fill layers | Same constraint — `make` + `contentLayer` + `solidColorLayer`. |
| Shape layers | `make` + `contentLayer` + `rectangle`; the extra colour key inside the shape descriptor is what broke round 1. |
| `selection.stroke` | Every argument shape tried so far is rejected; the ActionManager `stroke` command is the fallback. |
| `adjustCurves` | Argument shape unresolved; `adjustLevels` covers tone meanwhile. |
| Auto tone / contrast | `autoColor`/`autoTone`/`autoContrast` commands are **not** invocable, but `ArtLayer.autoLevels()` and `autoContrast()` exist in the DOM and need testing. |

**Genuinely unavailable on this build**

| Feature | Evidence |
| --- | --- |
| `selectFocusArea` | *command not currently available*, with and without a descriptor |
| `cameraRawFilter` | Same, with an empty descriptor and with a `filterFX` descriptor |
| `neuralFilters` | Same — cloud feature |
| `generativeFill` | Same — cloud feature; needs its own investigation (account, region, credits) before it can be promised |

## Architecture the phases build toward

Four verbs, plus an escape hatch. An agent needs a small number of composable
tools, not two hundred thin ones.

| Tool | Verb | Status |
| --- | --- | --- |
| `photoshop_status` | *is it there* | shipped |
| `photoshop_inspect` | *what is on screen* | shipped |
| `photoshop_apply` | *do these things* | **shipped** |
| `photoshop_cutout` | *batch subject extraction* | shipped |
| `photoshop_batch` | *do those things to many files* | **shipped** |
| `photoshop_run_jsx` | *anything else* | shipped |
| `photoshop_reference` | *teach me the vocabulary* | shipped |
| a registered **skill** | *how to work well here* | **shipped** (`photoshop`)|

Two properties make this composable rather than a menu:

- **One vocabulary, two drivers.** `photoshop_apply` runs a list of operations
  against open documents; `photoshop_batch` runs the *same* list against a list
  of files. Operations are declared once.
- **Discovery instead of prompt bloat.** The full operation vocabulary lives in
  `photoshop_reference` and in a skill loaded on demand, so the standing prompt
  stays small and the model can still learn every operation when it needs to.

## Phases

### Phase 0 — the bridge ✅ shipped

Windows COM + ExtendScript bridge; `status`, `cutout`, `run_jsx`; per-output
alpha verification; one Photoshop session per batch; verified end to end.

### Phase 1 — see what is on screen ✅ shipped

`photoshop_inspect`: every open document, then for one of them its size,
resolution, colour mode, bit depth, profile, path, unsaved state, active layer,
selection bounds, history position and channel/path/guide counts — followed by the
complete layer tree, where each layer carries its index path, name path, kind,
visibility, opacity, fill opacity, blend mode, clipping, mask presence, vector
mask, layer effects, centre flags, bounds, and for text layers their content, size,
font and justification.

Mask and layer-effects presence have no DOM property to read, so they come from an
`executeActionGet` lookup keyed by layer id — a reference built from an id never
changes the active layer, which is what keeps the inspection genuinely read-only.

Verified by `test/e2e.mjs` against a fixture PSD carrying a group, a nested text
layer and a masked pixel layer: every one of those facts is asserted in the report.

Why this came first: almost every real request is relative to something already
open — "把背景层换成蓝色", "export every layer in that group". Without this the
agent guesses at layer names, and guessing is what makes an agent unreliable.

### Phase 2 — the operation vocabulary ✅ shipped

`photoshop_apply` runs a plan: an ordered array of `{ op, …fields }` objects
executed inside one Photoshop session, wrapped in a single undo step when a
document is already open. Plus `photoshop_reference`, which returns the
vocabulary on demand so the standing prompt stays small.

93 operations across nine groups:
| Group | Count | Covers |
| --- | --- | --- |
| `document` | 16 | open, new, close, save_as, resize, canvas, crop, rotate, flip, trim, flatten, merge, duplicate, mode, profile, export_layers |
| `layer` | 23 | create, delete, duplicate, rename, move, group, ungroup, opacity, fill opacity, blend mode, visibility, lock, unlock background, rasterize, smart object, merge down, masks (add / delete / apply / invert / refine), clipping mask, layer styles |
| `adjust` | 12 | levels, brightness/contrast, hue/saturation, vibrance, black & white, desaturate, invert, threshold, posterize, equalize, auto levels, auto contrast |
| `filter` | 20 | gaussian / motion / radial / smart blur, unsharp mask, sharpen ×3, add noise, dust & scratches, median, despeckle, high pass, maximum, minimum, offset, custom filter, pinch, spherize, twirl |
| `select` | 14 | all, none, invert, clear, subject, sky, remove background, expand, contract, feather, smooth, border, save/load channel |
| `paint` | 4 | add text, edit text, fill, add colour layer |
| `action` | 1 | list the Actions panel (playing is deliberately not offered — see Phase 3) |
| `history` | 2 | step backward, step forward |
| `metadata` | 1 | set document metadata |

**Verified by `test/e2e.mjs`**: 102 operations across seven plans plus
`export_layers` and `list_actions`, applied against a real Photoshop, with a
fixture check that the documented vocabulary and the implemented handlers are the
same list.

#### What building it taught us about this Photoshop

Every one of these was a bug first, and each one is now encoded in the handlers:

- **Photoshop's DOM layer methods act on the *selected* layer, not on the object
  you called them on.** `layerA.adjustLevels(…)` while `layerB` is active either
  fails with "the current layer is empty" or silently adjusts `layerB`. Every
  targeted operation therefore selects its target first — which also means
  targeting a layer makes it active, and `photoshop_inspect` will show that.
- **`eval` does not see Photoshop's global host objects inside the script string
  that `suspendHistory` evaluates.** A call-time `eval('BlendMode.MULTIPLY')` in
  that nested scope yields `undefined`, which Photoshop reports as a bare
  "invalid enumeration value". Enum tables are now resolved once at load time.
- **A resolved-at-call-time enum is not enough**: `RGB` exists in both
  `ChangeMode` and `NewDocumentMode`, and passing one where the other belongs
  produces the same opaque error. The two now have separate tables.
- **`preserve transparency` defaults to *off* here**, not on. On a brand-new
  transparent layer, preserving transparency fills nothing at all — a silent
  no-op that only surfaces later as "the current layer is empty".
- **Creating a content or adjustment layer through ActionManager is not possible
  on this build** (`make` + `contentLayer` / `adjustmentLayer` fails with a bare
  program error). `add_color_layer` produces the same pixels through the DOM, and
  a live fill layer stays out of the vocabulary rather than being promised.
- **Releasing a clipping mask has no working command** — `releaseClippingMask`
  is unavailable and `groupEvent` with `group=false` is rejected — but the
  layer's own read-write `grouped` property does it.
- **Some filter signatures carry more required arguments than the reference
  suggests**: `applySmartBlur` needs four, not three. Radial blur and smart blur
  also have separate, non-interchangeable `quality` enumerations.
- **Grouping a plan must not swallow an operation failure.** A failure raised
  inside `suspendHistory` originally left the plan reported as successful with
  nothing applied; the recorded current operation is now what distinguishes "an
  operation failed" from "grouping is unavailable here".

### Phase 3 — batch and production ✅ shipped

- **`photoshop_batch`** — the same operation plan over many files, inside one
  Photoshop session. Each file is opened, run through the plan, saved to the
  batch output directory and closed without saving, so an input is never written
  to. A failure on one file is recorded and the batch continues. The plan may not
  contain `open`, `new_document`, `close` or `save_as`, because the batch owns
  those steps — refused with the reason rather than allowed to do something
  surprising.
- **`export_layers`** — every layer of a document to its own file, each keeping
  the full canvas so the outputs line up, with original visibility restored
  afterwards (including on failure).
- **`list_actions`** — read the Actions panel: the sets, and the actions in the
  currently targeted one. Photoshop exposes sets by index and one set's actions
  by a reference chained through that index, but the chained form answers with a
  synthesised label rather than the action's real name, so the usable names come
  from the unchained form.
- **The `photoshop` skill** — registered through `ctx.skills.register`, carrying
  the workflow, the addressing scheme, the safety rules and this installation's
  quirks. Loaded on demand, so the standing prompt stays small.

**`play_action` was investigated and deliberately rejected.** The evidence:

- A recorded action can open a dialog. `app.doAction` was run over Photoshop's
  own shipped actions, and one of them opened the Channel Mixer dialog while
  another raised a playback-error alert asking Continue or Stop.
- **`DialogModes.NO` does not suppress those dialogs** — they are governed by the
  Actions panel's playback options, not by the scripting dialog mode.
- A COM call blocked behind a modal cannot be cancelled from this side. The
  timeout stops our call while Photoshop keeps waiting for a click that no script
  can deliver, and *every later call* is then refused with
  `RPC_E_SERVERCALL_RETRYLATER` until a human dismisses the dialog. During this
  investigation that left Photoshop unusable for about twenty minutes.
- Killing the client does not stop the server: the script that timed out kept
  running inside Photoshop, raising a fresh dialog per failing action.

So the vocabulary offers the safe half — reading the panel — and leaves playing
to the human, who can see the dialog. `list_actions` says so in its own summary.

Two robustness changes came out of it:

- The bridge now **retries on `RPC_E_SERVERCALL_RETRYLATER` for two minutes**
  before failing. Photoshop answers with that while it is busy — mid-filter, with
  a dialog up, or simply because the user is working in it — and it means "ask
  again shortly", not "failed". Reporting it as a failure is how a plugin looks
  broken while the user is merely using their own application.
- The failure message for `PHOTOSHOP_BUSY` now points at the real cause and the
  real remedy: look at the Photoshop window, because something is waiting for a
  click and the plugin's channel is blocked by the very thing it would use to
  clear it.

### Phase 4 — AI and cloud: answered, not shipped

The AI and cloud features were investigated and the answer for this installation
is no: `generativeFill`, `neuralFilters`, `cameraRawFilter` and `selectFocusArea`
all resolve as command names and then refuse to run, and `app.featureEnabled`
reports nothing useful. Rather than ship a tool that fails obscurely, the plugin
**reports the finding**: `photoshop_status` now lists what has been established as
unavailable, with the note that it is a finding from this installation and that
`test/probe-operations.mjs` is how to re-establish it after a Photoshop upgrade.

That is the honest version of "covering the AI capabilities": the agent knows
before it promises the user something whether this machine can do it.

### Phase 5 — quality and ergonomics — partly shipped

**Shipped: edge quality that can be measured, and edge refinement that measurably
improves it.**

`lib/png.js` now decodes a PNG far enough to count its alpha structure: how many
pixels are fully transparent, fully opaque, and *partly* transparent. The partial
count is the width of the soft band along the outline, so "the edges look better"
stopped being an opinion. It inflates the image data with Node's own zlib and
undoes the per-scanline filters — still zero dependencies.

With that measurement in place, the cutout gained a refinement stage:

- The `select-subject` path now builds a **layer mask** instead of inverting and
  clearing the selection. A mask keeps the selection's own anti-aliasing and can
  be refined afterwards; a cleared selection cannot.
- `contract_px` shrinks the selection before the cutout, dropping the rim of
  background the subject was sitting on. This is the stand-in for Photoshop's
  Matting menu, which is not scriptable on this build.
- `feather_px` softens the outline.
- `mask_blur_px` blurs the mask itself afterwards, through the new `refine_mask`
  operation.

Measured on the same input, with `feather_px: 2, contract_px: 1, mask_blur_px: 1`:

| Cutout | Partial-alpha pixels | Soft band |
| --- | --- | --- |
| plain | 1,271 | 0.75% |
| refined | **12,637** | **7.36%** |

A tenfold wider transition band, verified by the test rather than asserted, and
confirmed by eye to be a genuine edge rather than a blur.

**What this Photoshop will not let a script do here**, all established by
execution:

- `defringe`, `removeWhiteMatte`, `removeBlackMatte` and `colorDecontaminate` —
  the whole Layer > Matting menu plus Select and Mask's colour decontamination —
  are **not available** to a script on this build. Contracting the selection is
  the honest substitute, and the vocabulary says so instead of promising a
  halo-free edge.
- Blurring a mask works, but only while the mask is the *active channel*.
- `adjustLevels` on a selected mask channel fails, so the usual "blur then
  re-tighten with Levels" trick for mask refinement is not available headlessly;
  `applyGaussianBlur` on the mask is the controllable knob that remains.

**Remaining:** thumbnail previews written alongside results, and progress reporting
for long batches.

#### Dry runs

`photoshop_apply` accepts `dry_run: true`, which resolves every operation against
the live state — each `document`, `target` and `into` — and reports what it would
touch without touching it. It catches the failure that actually happens in
practice, a layer name that was guessed rather than read from
`photoshop_inspect`. It resolves references rather than validating every field,
because field validation lives in the handlers and running them is the thing a
dry run exists to avoid.

Verified by the test with the strongest available evidence: a plan of three
operations, one of which names a missing layer, reports the two that resolve and
the one that does not, and the document's history state count is **identical
before and after**.

#### What this Photoshop will not do, and how that was established

Three separate investigations ended in a rejection rather than a feature, each
because a modal dialog blocks the only channel that could dismiss it:

| Rejected | Evidence |
| --- | --- |
| `play_action` | A shipped action raised a playback-error alert and another opened the Channel Mixer. `DialogModes.NO` does not suppress them — they are governed by the Actions panel's playback options. |
| `makeContactSheet` | `app.makeContactSheet` opens the **Contact Sheet II** dialog whatever options object it is given; its window class is `CScriptPs_WindowClass`, not a standard dialog class, so even a window-level sweep has to know to look for it. |
| `app.featureEnabled` | Answers `false` for all 26 candidate feature names, in 0 ms, and never throws — it carries no usable signal here, so availability is reported from executed evidence instead. |

The common thread is worth stating plainly: **a timed-out call does not stop
Photoshop.** The client is killed, the script keeps running, and every later call
is refused with `RPC_E_SERVERCALL_RETRYLATER` until a human clears whatever
dialog is up. The bridge's two-minute retry and its `PHOTOSHOP_BUSY` message exist
because of that, and the vocabulary simply does not offer the operations that
provoke it.

### Phase 6 — deferred by the user

Client-side UI (settings page, result gallery) and video frame extraction.

## Standing constraints

- **Windows only**, COM + ExtendScript. This is a property of Photoshop's
  automation surface, not a shortcut.
- **Zero runtime dependencies.** Nothing outside Node's standard library, so the
  plugin cannot fail to load because of how a package manager hoisted something.
- **Never write to an input file.** Every document opens read-only in effect and
  closes without saving; output goes only where the caller asked.
- **Only close what we opened.** Documents the user has open are reported, never
  touched.
- **Restore `app.displayDialogs`.** Suppressed for the duration of a script — a
  modal would block the bridge forever — and restored in `finally`.
- **Verify, do not assume.** Every phase adds its operations to the execution
  matrix, and a feature is only documented as available once it appears there as
  `ok`.
