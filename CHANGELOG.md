# Changelog

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
