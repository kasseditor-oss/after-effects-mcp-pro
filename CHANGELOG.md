# Changelog

## 2.1.0

Server 2.1.0, AE listener 2.0.1 (unchanged; no reinstall needed).

- `get_project_info` returns a fast summary by default (counts, first 50 comps); `detail: true` for everything.
- Previews use the comp background color (`background: comp | checker | transparent`).
- Batch errors show the hint once; name lists in hints are capped at 10.
- `remove_unused_footage`, and `delete_layers` `removeSources` to clean up Solids-folder leftovers.
- Texts over 20,000 characters are refused unless `allowLargeText: true`.
- Parallel calls are coalesced into one listener pass (20 parallel calls: 3.8 s -> 0.95 s). `AE_MCP_NO_COALESCE=1` turns it off.
- `parkViewer` option for `precompose_layers`, `duplicate_composition`, `sequence_layers`, `run_extendscript`.
- `outputSchema` + `structuredContent` on the 8 main read tools.
- MCP progress notifications (batch, contact sheet, `render_in_background` with `wait`).
- New tools: `replace_footage`, `list_presets`, `get_properties_at_time`, `list_essential_properties`, `set_essential_property`, `add_to_essential_graphics`, `begin_undo_group`, `end_undo_group`.
- Platform layer (`src/platform/`) for Windows and macOS (macOS unit-tested, not run on a real Mac).
- CI: type check, ES3 parse of every `.jsx`, `tools/list` snapshot.

## 2.0.1

- Activity card (MCP Apps) for every tool call, I/O retry, truncated text and paginated lists, batch `isError` / `atomic`, `timeoutSeconds` everywhere, cancellation of queued calls, outdated-listener warning, viewer parking in big batches, one-trip JPEG contact sheets, compact JSON, stress test, CI.
