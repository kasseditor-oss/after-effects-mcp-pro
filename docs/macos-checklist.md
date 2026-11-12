# macOS validation checklist

The macOS code path (`src/platform/macos.ts`, `scripts/install-ae.mjs`, the listener) is
unit-tested in CI on `macos-latest`, but it has **not been run against a real After Effects
on a Mac yet**. This checklist is for the first person who does. Report the results in an
issue (template "Bug report") with the output of `bridge_status`.

Use a new, empty project. Do not run the live test on a project you care about: it creates
and deletes comps named `MCP Test ...` and `QA ...`.

## 0. Environment

- [ ] macOS version: `sw_vers`
- [ ] After Effects version(s) installed in `/Applications` (release and/or Beta)
- [ ] Node 18 or newer: `node -v`
- [ ] ffmpeg / ffprobe (optional, for the render and time-remap live checks): `brew install ffmpeg`

## 1. Install

```bash
git clone https://github.com/kasseditor-oss/after-effects-mcp-pro.git
cd after-effects-mcp-pro
npm ci && npm run build && npm test
```

- [ ] `npm test` passes (same result as CI)
- [ ] Open After Effects once and quit it (it creates its preference folders)
- [ ] `npm run install-ae` with AE **closed**. Expected:
  - `~/Library/Application Support/ae-mcp-pro/ae-mcp-pro-listener.jsx` exists
  - for each version folder in `~/Library/Preferences/Adobe/After Effects/<version>/Scripts/`:
    `Startup/ae-mcp-pro-startup.jsx` and `ScriptUI Panels/AE MCP Pro.jsx`
  - "scripting file/network access enabled" (the `Pref_SCRIPTING_FILE_NETWORK_SECURITY` line
    in `Adobe After Effects <version> Prefs.txt` becomes `"1"`, backup `.bak-aemcp`)
- [ ] Beta only: check whether AE (Beta) keeps its preferences in
  `~/Library/Preferences/Adobe/After Effects (Beta)/<version>` or in the release folder.
  `install-ae` installs into every `After Effects*` folder it finds; note which one the Beta uses.

## 2. Listener

- [ ] Start After Effects. Within a few seconds `~/Library/Application Support/ae-mcp-pro/heartbeat.json`
  is rewritten every second (`cat` it twice)
- [ ] Window > AE MCP Pro.jsx opens the panel: state "listening", Pause/Resume work,
  "Start with After Effects" checkbox toggles the Startup file (renamed to `.disabled`)
- [ ] With AE already running, `npm run install-ae` starts the listener without a restart
  (needs Automation permission, see step 4)

## 3. bridge_status

Add the server to Claude Code (`claude mcp add after-effects -- node "$PWD/build/index.js"`) or run
the live test below, then call `bridge_status`:

- [ ] `installs` lists the AE apps (`beta: true` for the Beta, release listed first)
- [ ] `listener.alive: true`, `mode: "listener"`
- [ ] `compatibility.aeVersion` shows the real version (e.g. `26.5x89`)
- [ ] `afterEffectsRunning: true` (`pgrep -x "After Effects"`; the Beta process is `After Effects (Beta)`)

## 4. Direct mode (no listener)

- [ ] `npm run install-ae -- --uninstall`, restart AE, then call `get_project_info` with
  `AE_MCP_MODE=direct`. macOS asks to allow the terminal / Claude to control After Effects
  (System Settings > Privacy & Security > Automation). After allowing, the call succeeds
  through `osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile ...'`
- [ ] Reinstall: `npm run install-ae`

## 5. Live test

```bash
npm run test:live          # creates and removes its own comps
```

- [ ] Number of passed checks: ____ / ____
- [ ] Known macOS differences (not failures): contact sheets come back as separate frames
  (no grid compositor on macOS), and `preview_frame` `background` fill is not applied
  (`sips` only resizes and converts)
- [ ] Note every FAIL line with its message

## 6. Render

- [ ] `render_in_background` with `preset: "mp4-h264-high"` and `wait: true` creates the file
  (`aerender` in `/Applications/Adobe After Effects <year>/aerender`)
- [ ] `ffprobe` shows `h264`; `prores-422` / `prores-4444-alpha` show `prores`
- [ ] `render_png_sequence` writes numbered PNGs

## 7. Stress (optional)

```bash
npm run test:stress
```

- [ ] Batch of 100 operations, time: ____ s

## What is still unverified

Until this checklist is run, these are assumptions taken from Adobe's documentation and the
Windows behaviour:

- the Beta's preference folder name and process name;
- `osascript DoScriptFile` with the app name taken from the `.app` bundle;
- modal dialog detection (not available on macOS: a blocked call ends with a timeout instead
  of naming the dialog);
- `sips` output sizes for previews.
