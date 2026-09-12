# dsh-plugin-photoshop

Let an agent inside DeepSeek Harness **drive your own Adobe Photoshop**: batch subject cutouts and batch scripting, without clicking through hundreds of files by hand.

[![Topic](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

[简体中文](README.md) · **English**

---

## The problem it solves

Extracting frames from a video and cutting the people out of them is a normal asset-production task. Photoshop's Select Subject is markedly better at it than any open-source matting model — but an agent cannot reach the Photoshop on your desktop, so you end up doing the whole batch by hand.

With this plugin installed, you ask in plain language:

> Cut the subjects out of every image in `D:\frames` and write them to `D:\cutouts`

and the agent drives your local Photoshop through the whole batch, producing **transparent PNGs** with a per-image report.

## Requirements

| | |
| --- | --- |
| OS | Windows (the bridge uses COM automation; macOS and Linux are not supported) |
| Photoshop | Any modern version — verified end to end on Photoshop 2026 (27.0). Select Subject needs Photoshop 2020 or newer. |
| Node.js | 20 or newer (already required by DSH itself) |
| Other | No ffmpeg, no Python, no third-party dependencies |

## Install

```bash
dsh plugin --profile web add dsh-plugin-photoshop
```

From source, before it is on npm:

```bash
dsh plugin --profile web add git+https://github.com/<you>/dsh-plugin-photoshop.git
```

Restart `dsh web` afterwards. The plugin is resident: every later session has the tools.

Remove it with:

```bash
dsh plugin --profile web remove dsh-plugin-photoshop
```

## The seven tools

### `photoshop_status`

Environment self-check, read-only — it opens nothing and modifies nothing. Reports the Photoshop version and build, whether it is already running, which documents are open, whether Select Subject and Remove Background exist in this version. **Run it first when a Photoshop call fails for a non-obvious reason.**

### `photoshop_inspect`

Read what is actually on screen. Read-only.

Every open document, then for one of them: size, resolution, colour mode, bit depth, colour profile, disk path, unsaved state, active layer, selection bounds, history position, and channel / path / guide counts.

Then the **complete layer tree**, where each layer carries its index path, name path, kind, visibility, opacity, fill opacity, blend mode, clipping, mask presence, vector mask, layer effects, background flag, bounds — and for text layers their content, size, font and justification.

Layers are identified **twice**, so later operations can address them either way:

- **index path** `0.1` — the second layer inside the first group
- **name path** `Header/Title` — what the user actually says out loud

**Why this came first:** almost every real request is relative to something already open — "make the background layer blue", "export every layer in that group". Without this the agent guesses at layer names, and guessing is what makes an agent unreliable.

### `photoshop_cutout` — the workhorse

Batch cutout. The whole batch runs **inside a single Photoshop session** rather than one round trip per image, which is an order of magnitude faster at a few hundred frames.

| Parameter | Meaning |
| --- | --- |
| `paths` | Required. Image files and/or directories, freely mixed |
| `output_dir` | Required. Created when missing |
| `mode` | `select-subject` (default) or `remove-background` |
| `recursive` | Walk subdirectories. Default false |
| `trim` | Trim the transparent margin so each PNG hugs its subject. Default **true** |
| `feather_px` | Soften the cut edge by N pixels. Default 0 |
| `contract_px` | Shrink the selection by N pixels before cutting, dropping the rim of background the subject sat on — the most effective way to kill a coloured halo, and the stand-in for Photoshop's Matting menu, which is not scriptable here. Default 0 |
| `mask_blur_px` | Blur the layer mask after the cutout, softening the outline further. Default 0. The stand-in for Select and Mask, which cannot run headless |
| `max_side` | Cap the longest side, scaling proportionally. Default 0 (keep original) |
| `suffix` | Text inserted before `.png` |
| `overwrite` | Replace existing outputs. Default false (skip and say so) |
| `limit` | Process at most N images — handy for trying a few frames first |
| `timeout_ms` | Time budget for the whole batch; raise it for hundreds of images |

Output is **PNG-24 with alpha**, named after each input.

**Every output is verified against its PNG header for an alpha channel.** A file that silently came back opaque is reported as `NO ALPHA` with advice to switch mode, so a fake success cannot slip through.

**And its edge quality is measured.** The plugin decodes the PNG, inflates the image data and counts the alpha samples: fully transparent, fully opaque, and *partly* transparent. The partial count is the width of the soft transition band along the outline, which turns "the edges look better" into a number. On the same input, adding `feather_px: 2, contract_px: 1, mask_blur_px: 1` gives:

| Cutout | Partial-alpha pixels | Soft band |
| --- | --- | --- |
| plain | 1,271 | 0.75% |
| refined | **12,637** | **7.36%** |

A tenfold wider transition band — produced by the test, not asserted.

### `photoshop_batch` — production runs

Apply **the same list of operations** to a set of files, all inside **one
Photoshop session**.

| Parameter | Meaning |
| --- | --- |
| `paths` | Required. Image files and/or directories |
| `ops` | Required. The operations applied to every file — the same vocabulary as `photoshop_apply` |
| `output_dir` | Required. Where results are written |
| `output_format` | `png` (default, the only one that keeps transparency), `jpeg`, `psd`, `tiff` |
| `suffix` | Text inserted before the extension |
| `overwrite` | Replace existing outputs. Default false |
| `recursive` | Walk subdirectories |
| `limit` | Process at most this many files |

Each file is **opened → run through the plan → saved to the output directory →
closed without saving**, so an input is never modified. A failure on one file is
recorded and **the batch carries on** — stopping at the first bad frame is
useless for production work.

The plan may **not** contain `open`, `new_document`, `close` or `save_as`: the
batch handles those itself. Including one is refused with the reason, and
`save_as` especially so — it would make every input write to the same path.

### `photoshop_apply` — the general-purpose hand

Run an ordered list of **named operations** against the open documents. Document
setup and resizing, layer creation / naming / ordering / grouping, masks,
opacity, blend modes, layer styles, tonal and colour adjustments, filters, text,
fills, selections, history and metadata.

**93 operations** in nine groups:

| Group | Count | Covers |
| --- | --- | --- |
| `document` | 16 | open, new, close, save as, resize, canvas, crop, rotate, flip, trim, flatten, merge, duplicate, mode, profile, export layers |
| `layer` | 23 | create, delete, duplicate, rename, move, group, ungroup, opacity, fill opacity, blend mode, visibility, lock, unlock background, rasterize, smart object, merge down, masks (add / delete / apply / invert / refine), clipping mask, layer styles |
| `adjust` | 12 | levels, brightness/contrast, hue/saturation, vibrance, black & white, desaturate, invert, threshold, posterize, equalize, auto levels, auto contrast |
| `filter` | 20 | gaussian / motion / radial / smart blur, unsharp mask, sharpen ×3, add noise, dust & scratches, median, despeckle, high pass, maximum, minimum, offset, custom filter, pinch, spherize, twirl |
| `select` | 14 | all, none, invert, clear, subject, sky, remove background, expand, contract, feather, smooth, border, save/load channel |
| `paint` | 4 | add text, edit text, fill, add colour layer |
| `action` | 1 | list the Actions panel (playing is deliberately not offered — see the roadmap) |
| `history` | 2 | step backward, step forward |
| `metadata` | 1 | set document metadata |

Two properties make it dependable:

- **The whole plan is one undo step.** With a document already open the sequence
  runs inside `suspendHistory`, so a single Ctrl+Z reverts everything the agent
  did. A plan that works with history itself can opt out.
- **The plan is validated before Photoshop is involved.** A misspelled operation
  costs a sentence, not a round trip: `Unknown operation "gausian_blur". Did you
  mean gaussian_blur, …`.

Failure reporting is designed to be actionable: which operation failed, by name
and position, why, what had already been applied, and whether one undo reverts
all of it.

### `photoshop_reference`

Return the operation vocabulary on demand, optionally one group at a time. Needs
no running Photoshop and no document, which is what lets the standing prompt stay
small while the model can still learn every operation.

### `photoshop_run_jsx`

The escape hatch: run arbitrary ExtendScript inside Photoshop and return its result. Batch resizing, applying recorded actions (`.atn`), compositing, inspecting documents — anything Photoshop can script, without waiting for a dedicated tool.

## A skill ships with it

The plugin also registers a skill named **`photoshop`** carrying the working
knowledge: the order to call things in, how layers are addressed, the rules that
keep the user's files safe, and this installation's counter-intuitive corners (a
new layer is fully transparent, a background layer must be unlocked first, groups
cannot be filled, Select and Mask cannot run headless, and so on).

It is loaded **on demand**, so the standing prompt only says "load it before
non-trivial Photoshop work" and the model reads the rest when it needs to.

## Safety

This plugin drives your real Photoshop, so it is deliberately conservative:

- **It only touches documents it opened itself.** Files you opened by hand are never closed.
- **It never saves over an input.** Every document closes without saving; output goes only to the directory you name.
- **It does not change your Photoshop preferences.** Modal dialogs are suppressed for the duration of a script — a modal would block automation forever — and the previous value is restored immediately afterwards.
- **Overwriting needs explicit consent.** An existing output is skipped by default unless `overwrite: true`.
- **It is interruptible.** The batch polls a cancel marker between images, and a cancellation still reports everything that finished.

## How it works

Photoshop registers a version-independent COM automation server, `Photoshop.Application`, which exposes `DoJavaScript()` — run ExtendScript inside the running Photoshop and hand the result back. So the chain is:

```
Node (the plugin)
  └─ powershell.exe -File runner.ps1
       └─ New-Object -ComObject Photoshop.Application
            └─ DoJavaScript(generated ExtendScript)
                 └─ the real Photoshop
```

Design choices worth knowing:

- **Parameters are embedded as a JSON object literal.** JSON is a subset of JavaScript literals, so no escaping layer or base64 hop is needed.
- **Results travel by file, never by console.** Windows PowerShell encodes its console in the code page, which mangles non-ASCII paths and messages, so ExtendScript writes its own UTF-8 result file.
- **One script per batch.** One COM round trip covers the whole list, not one per image.
- **Zero dependencies.** The plugin imports nothing outside Node's standard library — not even a framework package — so it cannot fail to load because a package manager hoisted something differently in someone else's profile.

The cutout recipe itself was established empirically: Select Subject is the `autoCutout` action (`selectSubject` reports "command not currently available" on this version), and cutting out requires unlocking the background layer (`isBackgroundLayer = false`) before clearing the inverted selection — otherwise the delete fails.

## Troubleshooting

**`PHOTOSHOP_UNAVAILABLE`** — no Photoshop found on this machine, or its COM server is not registered. Confirm Photoshop launches normally.

**`Photoshop did not answer within the time budget`** — the batch is too large, or Photoshop was not running and this call had to cold-start it (which can take over a minute). Raise `timeout_ms`.

**`Select Subject found no subject in this image`** — Photoshop's AI found nothing to select. Try `mode: "remove-background"`, or check that the frame really contains a subject.

**An output reported `NO ALPHA`** — the cutout did not take effect and the image is still opaque. Re-run those images with `remove-background`.

## Development

```bash
git clone https://github.com/<you>/dsh-plugin-photoshop.git
cd dsh-plugin-photoshop
node test/e2e.mjs                 # runs the full verification against your Photoshop
node test/probe-capabilities.mjs  # reflects the real API surface of this installation
node test/probe-operations.mjs    # attempts every operation for real, producing a matrix
```

`test/e2e.mjs` builds the tool definitions, registers them on a stand-in registry, and then calls their `execute` exactly as the tool runtime would — covering the whole path except Cordis itself. It verifies each cutout output's alpha through its PNG header, and verifies every fact `photoshop_inspect` reports against a fixture document carrying a group, a nested text layer and a masked pixel layer. Inputs come from `~/Pictures/1.jpg` (pass your own image as an argument); artifacts land in `_research/e2e/` for inspection. The run clears its output directory first, so it is repeatable.

The two probes are what the capability inventory rests on: reflection gives the API surface this installation actually has, and the execution matrix establishes what really runs. A feature is documented as available only once it shows up there as `ok`.

To develop against a live profile instead:

```bash
dsh plugin --profile web add "C:\path\to\dsh-plugin-photoshop"
```

## License

[MIT](LICENSE)
