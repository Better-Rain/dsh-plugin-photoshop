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

89 operations across eight groups:

| Group | Count | Covers |
| --- | --- | --- |
| `document` | 15 | open, new, close, save_as, resize, canvas, crop, rotate, flip, trim, flatten, merge, duplicate, mode, profile |
| `layer` | 21 | create, delete, duplicate, rename, move, group, ungroup, opacity, fill opacity, blend mode, visibility, lock, unlock background, rasterize, smart object, merge down, masks (add / delete / apply / invert), clipping mask, layer styles |
| `adjust` | 12 | levels, brightness/contrast, hue/saturation, vibrance, black & white, desaturate, invert, threshold, posterize, equalize, auto levels, auto contrast |
| `filter` | 20 | gaussian / motion / radial / smart blur, unsharp mask, sharpen ×3, add noise, dust & scratches, median, despeckle, high pass, maximum, minimum, offset, custom filter, pinch, spherize, twirl |
| `select` | 14 | all, none, invert, clear, subject, sky, remove background, expand, contract, feather, smooth, border, save/load channel |
| `paint` | 4 | add text, edit text, fill, add colour layer |
| `history` | 2 | step backward, step forward |
| `metadata` | 1 | set document metadata |

**Verified by `test/e2e.mjs`**: 102 operations across seven plans, applied against
a real Photoshop, with a fixture check that the documented vocabulary and the
implemented handlers are the same 89 names.

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

### Phase 3 — batch and production — mostly shipped

**Shipped:**

- **`photoshop_batch`** — the same operation plan over many files, inside one
  Photoshop session. Each file is opened, run through the plan, saved to the
  batch output directory and closed without saving, so an input is never written
  to. A failure on one file is recorded and the batch continues. The plan may not
  contain `open`, `new_document`, `close` or `save_as`, because the batch owns
  those steps — refused with the reason rather than allowed to do something
  surprising.
- **The `photoshop` skill** — registered through `ctx.skills.register`, carrying
  the workflow, the addressing scheme, the safety rules and this installation's
  quirks. Loaded on demand, so the standing prompt stays small.

**Remaining:**

- `play_action` — run a recorded `.atn` action, including the sets shipped with
  Photoshop, and the batch equivalent.
- `export_layers` — write each layer of one document to its own file.
- Contact sheet, PDF presentation and photomerge wrappers around the `app`
  methods reflection found (`makeContactSheet`, `makePDFPresentation`,
  `makePhotomerge`, `makePicturePackage`).

### Phase 4 — AI and cloud, with honest availability reporting

Generative Fill / Expand, Neural Filters, Sky Replacement, Super Resolution.
These are the ones most likely to be region- or account-gated, so they ship behind
a capability check that reports *unavailable here* rather than failing obscurely.
`test/probe-operations.mjs` is where their real status gets recorded.

### Phase 5 — quality and ergonomics

Edge refinement for cutouts (headless, from `feather`/`expand`/`contract`/`smooth`
plus a mask blur), preview thumbnails written alongside results so the agent can
show its work, progress reporting for long batches, and a per-operation dry-run
that reports what a plan would touch before touching it.

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
