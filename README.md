# After Effects MCP Pro

An MCP server that lets Claude (or any MCP client) drive a live Adobe After Effects session: build compositions, layers, shapes and text, animate with keyframes, easing and presets, apply effects, render, and **look at the result** through frame previews.

It started from the most-starred After Effects MCP on GitHub ([Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp)). The architecture was rebuilt to fix that project's bugs, and the tool set grew from about 15 to 70.

## What is different

| | Dakkshin/after-effects-mcp | After Effects MCP Pro |
|---|---|---|
| Results | Most tools return "queued", then you call `get-results` | Every tool returns the real result in the same call |
| Concurrency | One shared command file and one shared result file. Calls overwrite each other. | Each call has its own id and its own result file. Calls are serialized. |
| Setup in AE | Open a floating panel by hand. Copying the panel needs admin rights. | Works with zero setup (`AfterFX.exe -r`). Optional startup listener with no admin rights and no panel to open. |
| Speed | Polls every 2 s | ~0.35 s per call in direct mode, ~0.15 s with the listener |
| Comp addressing | `app.project.items[compIndex]` (breaks when there are folders or footage) | Name or item id, with the active comp as the default |
| Layer addressing | Index only | Index, name, or a stable `id:<n>` |
| Non-English AE | Uses display names ("Transform", "Position") | Uses match names internally, so it works in any AE language |
| Undo | No undo groups | Every call is one undo step, `batch` included. There is an `undo` tool. |
| Errors | Modal `alert()` dialogs can freeze AE | Dialogs are suppressed. Errors come back with hints (for example, available layer names, or "did you mean" for effects). |
| Seeing the work | No | `preview_frame` and `preview_contact_sheet` return PNG images to the model |
| Rendering | No | Render queue, plus background `aerender` jobs with progress |
| Icon | No | The After Effects icon in server info and on every tool (MCP `icons`) |

## Tools (70)

- **Session:** `bridge_status`, `launch_after_effects`
- **Project:** `get_project_info`, `list_project_items`, `save_project`, `open_project`, `new_project`, `import_files`, `create_folder`, `organize_items`, `modify_item`
- **Compositions:** `list_compositions`, `get_composition`, `create_composition` (presets: 1080p, 4k, reels/tiktok, square…), `set_composition_settings`, `duplicate_composition`, `open_composition`, `precompose_layers`
- **Layers:** `create_text_layer`, `create_shape_layer` (several shapes per layer, Trim Paths, Repeater), `create_solid_layer` (and adjustment layers), `create_null_layer`, `create_camera`, `create_light`, `add_item_to_comp`, `list_layers`, `get_layer_details`, `set_layer_properties` (one or many layers), `duplicate_layer`, `delete_layers`, `reorder_layer`, `set_parent`, `set_track_matte` (AE 2023+ API), `split_layer`, `sequence_layers`, `align_layers`, `set_text`
- **Animation:** `get_property` and `set_property` (any property by path), `set_keyframes` (easing presets or custom ease), `remove_keyframes`, `set_expression` (reports expression errors), `check_expressions`, `animate_layer` (21 presets: fade, slide, pop, typewriter, text-fade-up, wiggle, bounce, loop…)
- **Effects:** `list_available_effects`, `apply_effect` (by name or match name; parameters can take keyframes or expressions), `get_layer_effects`, `modify_effect`, `apply_effect_template` (18 looks), `apply_preset_file` (.ffx)
- **Masks and markers:** `add_mask`, `remove_masks`, `add_marker`, `list_markers`, `remove_markers`
- **Render and preview:** `preview_frame`, `preview_contact_sheet`, `add_to_render_queue`, `get_render_queue`, `clear_render_queue`, `render_queue`, `render_in_background`, `get_background_render`
- **Utility:** `list_fonts`, `get_selection`, `select_layers`, `undo`, `execute_menu_command`, `run_extendscript`, `batch`

The server also has 3 resources (`aftereffects://project`, `aftereffects://compositions`, `aftereffects://selection`) and 3 prompts (`lower-third`, `kinetic-title`, `analyze-comp`).

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

The server picks the mode for each call based on the listener's heartbeat.

### Environment variables

| Variable | Use |
|---|---|
| `AE_MCP_AE_PATH` | After Effects install folder, if auto-detect fails |
| `AE_MCP_MODE` | Force `listener` or `direct` |
| `AE_MCP_BRIDGE_DIR` | Use a different bridge folder |
| `AE_MCP_DISABLE_EVAL=1` | Turn off `run_extendscript` |

## Tests

```bash
npm test               # 9 unit tests, no After Effects needed
npm run test:live      # end-to-end against a running After Effects (creates a "MCP Test" comp)
```

## License

MIT
