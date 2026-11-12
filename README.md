# After Effects MCP Pro

An MCP server that lets Claude (or any MCP client) drive a live Adobe After Effects session: build compositions, layers, shapes and text, animate with keyframes, easing and presets, apply effects and layer styles, render, and **look at the result** through frame previews.

![Demo: Claude builds a kinetic title in After Effects and checks it with a contact sheet](docs/demo.gif)

> Português: veja a [seção em português](#português) no fim.

## Install in 3 steps

1. **Install Node.js 18+** and have **After Effects 2022 or newer** (Windows or macOS).
2. **Set up the After Effects side** (listener, status panel, scripting permission; no admin rights):

   ```bash
   npx after-effects-mcp-pro setup
   ```

3. **Add the server to your client** (the setup prints these lines too):

   ```bash
   claude mcp add after-effects -- npx -y after-effects-mcp-pro
   ```

   ```json
   { "mcpServers": { "after-effects": { "command": "npx", "args": ["-y", "after-effects-mcp-pro"] } } }
   ```

Then ask, for example: *"Make a 1080x1920 kinetic title that says LAUNCH DAY, then show me a contact sheet."*

More client examples are in [`examples/`](examples/). `npx after-effects-mcp-pro --help` lists the options and environment variables.

## Why this MCP

| | |
|---|---|
| **Real results** | Every tool returns what After Effects did in the same call (ids, names, values, warnings), with typed `structuredContent` for read tools. |
| **Claude can see the work** | `preview_frame` returns a frame as an image; `preview_contact_sheet` returns one labelled grid of up to 12 frames. Claude checks its own animation and fixes it. |
| **93 tools** | Comps, text, shapes (Trim Paths, Repeater, gradients), masks, keyframes with bezier and spatial control, expressions and an expression library, 27 effect looks, layer styles, text animators, time remap, motion along a path, audio to keyframes, markers, Essential Graphics and `.mogrt`, render queue presets and background `aerender`. Full list: [docs/tools.md](docs/tools.md). |
| **Fast** | A listener inside After Effects answers in ~0.1 s per call; parallel calls share one round trip; `batch` runs up to 200 operations in one call and one undo step. |
| **Safe by design** | One undo step per call (`undo` tool, undo groups), dialogs suppressed, output files never overwritten silently, optional read-only mode, path sandbox and eval switch. |
| **Works in any AE language** | Properties are addressed by match name internally; layers by index, name or stable `id:<n>`. |
| **Visible in Claude** | Each call shows an After Effects activity card (MCP Apps) with the action, status and preview frames. |
| **Tested** | Unit tests in CI on Windows and macOS (Node 18/20/22), ~365 end-to-end checks against a running After Effects, including pixel checks of the rendered frames. |

## Tool profiles

Listing fewer tools saves model context. Unlisted tools still work when called by name or inside `batch`.

| `AE_MCP_TOOLSET` | Tools listed | Size of `tools/list` |
|---|---|---|
| `full` (default) | 93 | ~118 KB |
| `core` | 31 most used | ~29 KB |
| `minimal` | 10 | ~7 KB |

## Security

The server only talks to the After Effects on your own machine, but it can change projects and run code there. Choose what it exposes:

| Variable | Effect |
|---|---|
| `AE_MCP_EVAL=off` | Removes `run_extendscript` (arbitrary ExtendScript) from the tool list and rejects it, also inside `batch`. Default `on` in 2.x; **the default becomes `off` in 3.0**. `AE_MCP_DISABLE_EVAL=1` is the same as `off`. |
| `AE_MCP_READONLY=1` | Only tools that read or preview (`list_*`, `get_*`, `preview_*`, `bridge_status`, `check_expressions`). |
| `AE_MCP_ALLOWED_DIRS=C:\work;D:\renders` | Every file path a tool receives (imports, presets, projects, render outputs, saved previews) must resolve inside these folders: real paths are compared, `..` and links pointing outside are refused, and the error never reveals whether a file exists. `run_extendscript` is not constrained by it, so combine with `AE_MCP_EVAL=off`. |

Existing output files are never replaced unless the call passes `overwrite: true`. For shared or audited setups use [`examples/mcp.safe.json`](examples/mcp.safe.json). `bridge_status` reports the active modes.

## Tools

- **Session:** `bridge_status`, `launch_after_effects`
- **Project:** `get_project_info`, `list_project_items`, `save_project`, `open_project`, `new_project`, `import_files`, `replace_footage`, `create_folder`, `organize_items`, `modify_item`, `remove_unused_footage`
- **Compositions:** `list_compositions`, `get_composition`, `create_composition` (presets: 1080p, 4k, reels/tiktok, square…), `set_composition_settings`, `duplicate_composition`, `open_composition`, `precompose_layers`
- **Layers:** `create_text_layer`, `create_shape_layer`, `create_solid_layer` (and adjustment layers), `create_null_layer`, `create_camera`, `create_light`, `add_item_to_comp` (with `sourceIn`/`sourceOut` trims), `list_layers`, `get_layer_details`, `set_layer_properties`, `duplicate_layer`, `delete_layers`, `reorder_layer`, `set_parent`, `set_track_matte`, `split_layer`, `sequence_layers`, `align_layers`, `set_text`, `set_time_remap`
- **Animation:** `get_property`, `get_properties_at_time`, `set_property`, `set_keyframes` (easing presets, bezier, spatial tangents, roving), `remove_keyframes`, `set_expression`, `check_expressions`, `apply_expression_preset`, `animate_layer` (21 presets), `add_text_animator`, `keyframes_from_markers`, `position_along_path`
- **Effects:** `list_available_effects`, `apply_effect`, `get_layer_effects`, `modify_effect`, `apply_effect_template` (27 looks), `add_layer_style`, `list_presets`, `apply_preset_file`
- **Essential Graphics:** `add_to_essential_graphics`, `list_essential_properties`, `set_essential_property`, `set_essential_properties`, `instantiate_template`, `export_mogrt`
- **Masks, markers, audio:** `add_mask`, `modify_mask`, `remove_masks`, `markers`, `add_marker`, `list_markers`, `remove_markers`, `audio_to_keyframes`, `markers_from_audio_peaks`
- **Render and preview:** `preview_frame`, `preview_contact_sheet`, `add_to_render_queue` and `render_in_background` (presets `mp4-h264-high`, `prores-422`, `prores-4444-alpha`), `render_png_sequence`, `get_render_queue`, `clear_render_queue`, `render_queue`, `get_background_render`
- **Utility:** `list_fonts`, `get_selection`, `select_layers`, `undo`, `begin_undo_group` / `end_undo_group`, `execute_menu_command`, `run_extendscript`, `batch`

Parameters, types and an example for every tool: [docs/tools.md](docs/tools.md) (generated with `npm run docs`). The server also has resources (`aftereffects://project`, `aftereffects://compositions`, `aftereffects://selection`, `ae://docs/<tool>`) and prompts (`lower-third`, `kinetic-title`, `analyze-comp`).

## Compatibility

- **After Effects:** 2022 (22.0) or newer; developed and tested on 2026 (26.x). Older versions get a warning in `bridge_status`.
- **Node.js:** 18 or newer (CI runs 18, 20 and 22).
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

- Roto Brush and Content-Aware Fill have no ExtendScript API, so no tool can drive them. The Curves effect's curve and gradient stops are not scriptable either (the `curves` look uses Levels; gradients use a Gradient Ramp).
- A script that After Effects is already running cannot be interrupted (cancel and timeouts only stop waiting).
- After Effects closes an undo group at the end of each script run, so `begin_undo_group` / `end_undo_group` are tracked by the server: the `undo` tool reverts the whole group in one call, but Ctrl+Z inside After Effects still undoes one call at a time.
- GIF output: After Effects has no GIF output module and scripts cannot pick a Media Encoder preset. Render `prores-422` or `mp4-h264-high` and convert.
- macOS: implemented in `src/platform/macos.ts` and unit-tested in CI, but **not yet run against a real After Effects on a Mac**. Contact sheets come back as separate frames and the preview background fill is not applied. AppleScript needs Automation permission for After Effects. To validate on a Mac, follow [docs/macos-checklist.md](docs/macos-checklist.md).

## How it works

1. **Listener mode** (after `setup`): a startup script inside After Effects watches the bridge folder (`%APPDATA%/ae-mcp-pro` or `~/Library/Application Support/ae-mcp-pro`) every 120 ms. The optional panel **Window > AE MCP Pro.jsx** shows status and the last calls, and has Pause and "Start with After Effects".
2. **Direct mode** (no setup): the server runs `AfterFX.exe -r <script>` on Windows, or AppleScript `DoScriptFile` on macOS.

The server picks the mode for each call from the listener's heartbeat. `bridge_status` shows the mode, latency (avg/p50/p95), timeouts, the AE version, and warns when the installed listener is older than the server (run the setup again after updating).

In After Effects, **Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network** must be on. The setup turns it on for you if After Effects is closed.

### Activity card

Each tool links to the MCP App resource `ui://after-effects/activity.html`. Clients that support MCP Apps (Claude Desktop, claude.ai) show it under the tool call: the After Effects icon, what Claude is doing, a live status, a short summary and any preview frames. Clients without MCP Apps ignore it.

### Environment variables

| Variable | Use |
|---|---|
| `AE_MCP_TOOLSET` | `full`, `core` or `minimal` (see Tool profiles) |
| `AE_MCP_EVAL`, `AE_MCP_READONLY`, `AE_MCP_ALLOWED_DIRS` | See Security |
| `AE_MCP_AE_PATH` | After Effects install folder, if auto-detect fails |
| `AE_MCP_MODE` | Force `listener` or `direct` |
| `AE_MCP_BRIDGE_DIR` | Use a different bridge folder |
| `AE_MCP_PRETTY=1` | Indented JSON in responses (default is compact, fewer tokens) |
| `AE_MCP_ASSUME_AE_VERSION` | Treat After Effects as this version (e.g. `23.0`), see Compatibility |

## Development

```bash
git clone https://github.com/kasseditor-oss/after-effects-mcp-pro.git
cd after-effects-mcp-pro
npm ci && npm run build
npm run install-ae     # same as `setup`, from a clone
npm run icon           # Windows: takes the After Effects icon from your install (optional)
```

```bash
npm test               # unit tests incl. the tools/list snapshots, no After Effects needed (CI)
npm run typecheck      # tsc --noEmit
npm run check:es3      # every .jsx parses as ECMAScript 3, no chained conditionals
npm run docs           # regenerate docs/tools.md (CI fails when it is out of date)
npm run test:live      # ~365 end-to-end checks against a running After Effects; removes what it created
npm run test:live:keep # same, but keeps the "MCP Test" comp for inspection
npm run test:stress    # latency, parallel calls, unicode, huge text, big batches, timeouts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules (ExtendScript ES3, tests for every fix) and [CHANGELOG.md](CHANGELOG.md) for changes.

## Português

**After Effects MCP Pro** é um servidor MCP que deixa o Claude (ou outro cliente MCP) controlar o After Effects aberto no seu computador: cria comps, layers, textos, shapes, animações, efeitos e estilos de layer, renderiza e **olha o resultado** por previews de frames.

Instalação em 3 passos:

1. Tenha o **Node.js 18+** e o **After Effects 2022 ou mais novo** (Windows ou macOS).
2. Rode `npx after-effects-mcp-pro setup` (instala o listener e o painel no After Effects, sem admin).
3. Adicione ao Claude Code: `claude mcp add after-effects -- npx -y after-effects-mcp-pro` (o setup mostra também o trecho para o Claude Desktop).

Depois peça, por exemplo: *"Crie um título cinético 1080x1920 escrito LANÇAMENTO e me mostre um contact sheet."*

Para uso compartilhado, use `AE_MCP_EVAL=off` (desliga o `run_extendscript`), `AE_MCP_READONLY=1` (só leitura) e `AE_MCP_ALLOWED_DIRS` (limita as pastas). `AE_MCP_TOOLSET=core` lista menos ferramentas e economiza contexto. Problemas: abra uma issue com a versão do AE, o sistema e a saída do `bridge_status`.

## License

MIT
