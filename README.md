# After Effects MCP Pro

An MCP server that lets Claude (or any MCP client) drive a live Adobe After Effects session: build compositions, layers, shapes and text, animate with keyframes, easing and presets, apply effects, render, and **look at the result** through frame previews.

It started from the most-starred After Effects MCP on GitHub ([Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp)). The architecture was rebuilt to fix that project's bugs, and the tool set grew from about 15 to 70.

## What is different

| | Dakkshin/after-effects-mcp | After Effects MCP Pro |
|---|---|---|
| Results | Most tools return "queued", then you call `get-results` | Every tool returns the real result in the same call |
| Concurrency | One shared command file and one shared result file. Calls overwrite each other. | Each call has its own id and its own result file. Calls are serialized. |
| Setup in AE | Open a floating panel by hand. Copying the panel needs admin rights. | Works with zero setup (`AfterFX.exe -r`). Optional startup listener with no admin rights and no panel to open. |
| Speed | Polls every 2 s | ~0.4-0.6 s per call in direct mode, ~0.1-0.15 s with the listener |
| Comp addressing | `app.project.items[compIndex]` (breaks when there are folders or footage) | Name or item id, with the active comp as the default |
| Layer addressing | Index only | Index, name, or a stable `id:<n>` |
| Non-English AE | Uses display names ("Transform", "Position") | Uses match names internally, so it works in any AE language |
| Undo | No undo groups | Every call is one undo step, `batch` included. There is an `undo` tool. |
| Errors | Modal `alert()` dialogs can freeze AE | Dialogs are suppressed. Errors come back with hints (for example, available layer names, or "did you mean" for effects). |
| Seeing the work | No | `preview_frame` returns the frame as an image; `preview_contact_sheet` returns one labelled grid of up to 12 frames (JPEG, ~1.5-3 s) |
| Rendering | No | Render queue, plus background `aerender` jobs with progress |
| Visible in Claude | No | Every call shows an After Effects activity card in Claude Desktop / claude.ai (MCP Apps): Ae icon, action, status, result and previews |
| Big projects | Full layer lists and texts in every answer | Long texts cut to 200 characters in summaries, paginated `list_layers` / `list_project_items`, compact JSON |
| Long operations | Fixed wait, then a misleading error | `timeoutSeconds` on every tool, honest timeout messages, queued calls can be cancelled |

## Tools (79)

- **Session:** `bridge_status`, `launch_after_effects`
- **Project:** `get_project_info` (fast summary, `detail` for everything), `list_project_items`, `save_project`, `open_project`, `new_project`, `import_files`, `replace_footage`, `create_folder`, `organize_items`, `modify_item`, `remove_unused_footage`
- **Compositions:** `list_compositions`, `get_composition`, `create_composition` (presets: 1080p, 4k, reels/tiktok, square…), `set_composition_settings`, `duplicate_composition`, `open_composition`, `precompose_layers`
- **Layers:** `create_text_layer`, `create_shape_layer` (several shapes per layer, Trim Paths, Repeater), `create_solid_layer` (and adjustment layers), `create_null_layer`, `create_camera`, `create_light`, `add_item_to_comp`, `list_layers`, `get_layer_details`, `set_layer_properties` (one or many layers), `duplicate_layer`, `delete_layers`, `reorder_layer`, `set_parent`, `set_track_matte` (AE 2023+ API), `split_layer`, `sequence_layers`, `align_layers`, `set_text`
- **Animation:** `get_property`, `get_properties_at_time` (many layers/properties in one call) and `set_property` (any property by path), `set_keyframes` (easing presets or custom ease), `remove_keyframes`, `set_expression` (reports expression errors), `check_expressions`, `animate_layer` (21 presets: fade, slide, pop, typewriter, text-fade-up, wiggle, bounce, loop…)
- **Effects:** `list_available_effects`, `apply_effect` (by name or match name; parameters can take keyframes or expressions), `get_layer_effects`, `modify_effect`, `apply_effect_template` (18 looks), `list_presets` and `apply_preset_file` (.ffx)
- **Essential Graphics:** `add_to_essential_graphics`, `list_essential_properties`, `set_essential_property`
- **Masks and markers:** `add_mask`, `remove_masks`, `add_marker`, `list_markers`, `remove_markers`
- **Render and preview:** `preview_frame`, `preview_contact_sheet`, `add_to_render_queue`, `get_render_queue`, `clear_render_queue`, `render_queue`, `render_in_background`, `get_background_render`
- **Utility:** `list_fonts`, `get_selection`, `select_layers`, `undo`, `begin_undo_group` / `end_undo_group`, `execute_menu_command`, `run_extendscript`, `batch`

Every tool that runs inside After Effects accepts `timeoutSeconds`. `batch` runs up to 200 operations in one round trip and one undo step: a failure returns an error with the partial results, and `atomic: true` undoes the whole batch. Batches over 20 operations move the viewer off the comp while they run, which makes them several times faster.

The server also has 3 resources (`aftereffects://project`, `aftereffects://compositions`, `aftereffects://selection`) and 3 prompts (`lower-third`, `kinetic-title`, `analyze-comp`).

## Security

The server only talks to the After Effects on your own machine, but it can change projects and run code there. Choose what it exposes with environment variables:

| Variable | Effect |
|---|---|
| `AE_MCP_EVAL=off` | Removes `run_extendscript` (arbitrary ExtendScript) from the tool list and rejects it, also inside `batch`. Default `on` in 2.x; **the default becomes `off` in 3.0**. `AE_MCP_DISABLE_EVAL=1` is the same as `off`. |
| `AE_MCP_READONLY=1` | Only tools that read or preview (`list_*`, `get_*`, `preview_*`, `bridge_status`, `check_expressions`). |

| `AE_MCP_ALLOWED_DIRS=C:\\work;D:\\renders` | Every file path a tool receives (imports, presets, projects, render outputs, saved previews) must resolve inside these folders: real paths are compared, `..` and links pointing outside are refused, and the error never reveals whether a file exists. `run_extendscript` is not constrained by it, so combine with `AE_MCP_EVAL=off`. |

Existing output files are never replaced unless the call passes `overwrite: true` (`save_project`, `add_to_render_queue`, `render_in_background`, `render_png_sequence`, `preview_frame` `savePath`).

For shared or audited setups use `AE_MCP_EVAL=off`. `bridge_status` reports the active modes.

## Compatibility

- **After Effects:** 2022 (22.0) or newer; developed and tested on 2026 (26.x). Older versions get a warning in `bridge_status`.
- **Node.js:** 18 or newer (`engines` in `package.json`; CI runs 18, 20 and 22).
- **After Effects (Beta)** is detected on Windows and macOS and listed in `bridge_status` (`beta: true`), but a release install is preferred.

The server learns the AE version from the listener heartbeat (or the first `bridge_status` / `get_project_info` in direct mode). Features this AE lacks are refused before the call reaches After Effects, with a clear message:

| Feature | Needs | On older versions |
|---|---|---|
| `set_track_matte` with any matte layer (`setTrackMatte`) | 23.0 (2023) | Automatic fallback: the matte layer is moved directly above and `trackMatteType` is used |
| `caps` other than `normal` in `create_text_layer` / `set_text` (`fontCapsOption`) | 24.0 (2024) | Refused: type the text in capitals |
| `list_fonts` (`app.fonts`) | 24.0 (2024) | Refused: pass the PostScript name directly |
| `instantiate_template` (Essential Properties) | 17.0 (2020) | Refused |
| `set_essential_properties`, `export_mogrt` | 16.1 (2019) | Refused |
| Shape gradient colors | any | Always a Gradient Ramp effect (no scripting API for gradient stops) |

`AE_MCP_ASSUME_AE_VERSION=23.0` forces a version (testing, or forcing the older paths).

## Limitations

- Roto Brush and Content-Aware Fill have no ExtendScript API, so no tool can drive them.
- A script that After Effects is already running cannot be interrupted (cancel and timeouts only stop waiting).
- After Effects closes an undo group at the end of each script run, so `begin_undo_group` / `end_undo_group` are tracked by the server: the `undo` tool reverts the whole group in one call, but Ctrl+Z inside After Effects still undoes one call at a time.
- macOS: implemented in `src/platform/macos.ts` (After Effects in `/Applications`, direct mode through AppleScript `DoScriptFile`, bridge folder `~/Library/Application Support/ae-mcp-pro`, previews resized with `sips`) and unit-tested in CI, but never run against a real After Effects on a Mac. On macOS, contact sheets come back as separate frames and the preview background fill is not applied. AppleScript needs Automation permission for After Effects. To validate on a Mac, follow [docs/macos-checklist.md](docs/macos-checklist.md).

## Install

Requirements: After Effects 2022 or later on Windows or macOS, and Node 18 or later.

```bash
npm install
npm run build
npm run icon          # Windows: takes the After Effects icon from your install (optional)
npm run install-ae    # optional: auto-start listener + status panel (no admin)
```

In After Effects, turn on **Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network**. `install-ae` turns it on for you if After Effects is closed.

Register the server with your client:

```bash
claude mcp add after-effects -- node "/path/to/build/index.js"
```

```json
{ "mcpServers": { "after-effects": { "command": "node", "args": ["/path/to/build/index.js"] } } }
```

### How the bridge works

1. **Listener mode** (after `install-ae`): a startup script inside After Effects watches `%APPDATA%/ae-mcp-pro/queue` every 120 ms. The optional panel **Window > AE MCP Pro.jsx** shows status and recent commands, and has a pause button.
2. **Direct mode** (no install): the server runs `AfterFX.exe -r <script>` on Windows, or AppleScript `DoScriptFile` on macOS.

The server picks the mode for each call based on the listener's heartbeat. `bridge_status` shows the mode, latency (avg/p50/p95), timeouts, and warns when the installed listener is older than the server (run `npm run install-ae` again after updating).

### Activity card

Each tool links to the MCP App resource `ui://after-effects/activity.html`. Clients that support MCP Apps (Claude Desktop, claude.ai) show it under the tool call: the After Effects icon, what Claude is doing, a live status, a short summary and any preview frames. Clients without MCP Apps simply ignore it.

### Environment variables

| Variable | Use |
|---|---|
| `AE_MCP_AE_PATH` | After Effects install folder, if auto-detect fails |
| `AE_MCP_MODE` | Force `listener` or `direct` |
| `AE_MCP_BRIDGE_DIR` | Use a different bridge folder |
| `AE_MCP_DISABLE_EVAL=1` | Turn off `run_extendscript` |
| `AE_MCP_PRETTY=1` | Indented JSON in responses (default is compact, fewer tokens) |
| `AE_MCP_ASSUME_AE_VERSION` | Treat After Effects as this version (e.g. `23.0`), see Compatibility |

## Tests

```bash
npm test               # 21 unit tests incl. the tools/list snapshot, no After Effects needed (also run in CI)
npm run typecheck      # tsc --noEmit
npm run check:es3      # every .jsx parses as ECMAScript 3
npm run test:live      # ~100 end-to-end checks against a running After Effects; removes what it created
npm run test:live:keep # same, but keeps the "MCP Test" comp for inspection
npm run test:stress    # latency, parallel calls, unicode, huge text, big batches, timeouts
```

## License

MIT
