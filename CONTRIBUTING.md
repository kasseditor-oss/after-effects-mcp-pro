# Contributing

Thanks for helping. Bug reports with the `bridge_status` output and the After Effects version
are the most useful thing you can send (use the issue template).

## Setup

```bash
git clone https://github.com/kasseditor-oss/after-effects-mcp-pro.git
cd after-effects-mcp-pro
npm ci
npm run build
npm run install-ae      # After Effects side: listener, panel, scripting permission
```

Point your MCP client at `build/index.js` (see `examples/`).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | MCP server: tool listing, dispatch, policy checks, Node-side tools (previews, aerender) |
| `src/tools.ts` | Tool definitions (zod schemas, descriptions, docs) |
| `src/jsx/runtime.jsx` | ExtendScript runtime: one `H.<tool>` handler per tool that runs inside AE |
| `src/bridge.ts` | Sends scripts to AE (listener queue or direct mode) and waits for results |
| `src/platform/` | Windows / macOS differences (install discovery, script launch, image compositing) |
| `src/compat.ts` | After Effects version gates and fallbacks |
| `src/policy.ts` | Tool profiles, eval / read-only modes, path sandbox |
| `bridge/` | Listener (Startup script) and the ScriptUI panel |
| `test/` | `unit` (no AE), `live` (needs AE), `stress` |

## Rules

- **ExtendScript is ES3.** No `let`/`const`, arrow functions, `forEach`/`map`, template strings or
  native `JSON` (the runtime has a polyfill). Never chain conditionals (`a ? b : c ? d : e`):
  ExtendScript evaluates them wrongly. `npm run check:es3` enforces both.
- **Do not break the interface.** New parameters are optional. If behaviour changes, write it in
  `CHANGELOG.md`.
- **Every bug fix gets a test** that fails without the fix (unit test when possible, live test
  when it needs After Effects).
- **Visual features are checked with pixels**, not only with "no error": the live test renders
  frames with `preview_frame` and compares them.
- **Listener changes:** bump `VERSION` in `bridge/ae-mcp-pro-listener.jsx` and
  `LISTENER_VERSION` in `src/bridge.ts`, then run `npm run install-ae`.
- **Tool list changes:** update the snapshots with `UPDATE_SNAPSHOT=1 npm test` (check the diff)
  and regenerate `docs/tools.md` with `npm run docs`. Keep the full `tools/list` under 120 KB.

## Tests

```bash
npm run typecheck && npm run check:es3 && npm run build
npm test                 # unit tests, no After Effects needed (CI runs these on Windows and macOS)
npm run test:live        # needs After Effects open with an empty project; cleans up after itself
npm run test:stress      # performance scenarios
```

The live test only creates comps named `MCP Test ...` / `QA ...` in a temporary project. Do not
run it with a project you care about open.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `docs:`,
`test:`, `chore:`. One logical change per commit.
