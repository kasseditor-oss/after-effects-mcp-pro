# Publishing checklist (nothing has been published)

Everything below is prepared in the repository. **None of it has been run.** Each step needs
the repository owner's go-ahead.

| Where | Prepared files | Step (owner only) |
|---|---|---|
| GitHub | branch `fix/qa-round-3` | `git push` and open a pull request to `main` |
| npm | `package.json` (`bin`, `files`, `engines`, `repository`, `keywords`), `LICENSE` | `npm login && npm publish` (check the name is free: `npm view after-effects-mcp-pro`) |
| Claude Desktop extension | `manifest.json` (MCPB 0.3, validated with `npx @anthropic-ai/mcpb validate manifest.json`) | see "Building the .mcpb" below; attach the file to a GitHub release |
| Glama | `glama.json` | add the GitHub repository at glama.ai (it reads `glama.json` for maintainers) |
| Smithery | `smithery.yaml` (stdio, `npx -y after-effects-mcp-pro`) | submit the repository at smithery.ai. It is a local server: After Effects must run on the user's machine |

## Building the .mcpb

The bundle must contain the production dependencies only:

```bash
npm run build && npm run manifest
npm pack                                  # after-effects-mcp-pro-<version>.tgz
mkdir stage && tar -xzf after-effects-mcp-pro-*.tgz -C stage
cd stage/package && npm install --omit=dev --no-audit --no-fund
npx @anthropic-ai/mcpb pack . ../../after-effects-mcp-pro.mcpb
```

After installing the extension, the user still runs `npx after-effects-mcp-pro setup` once (or
the server works in direct mode).

## Verified locally

- `npm pack` creates the package; installed in an empty folder, `npx after-effects-mcp-pro --help`
  and `--version` work and the server answers `tools/list` over stdio.
- `npx @anthropic-ai/mcpb validate manifest.json` passes, and the steps above build a 3.3 MB `.mcpb` (not attached anywhere).
