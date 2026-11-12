# Client configuration examples

- `mcp.json`: copy to `.mcp.json` in a project (Claude Code) or merge into
  `claude_desktop_config.json` (Claude Desktop). Starts the server with `npx`.
- `mcp.safe.json`: shared or audited setups. Fewer listed tools (`core`), no
  `run_extendscript` (`AE_MCP_EVAL=off`), and file tools limited to two folders.

Run `npx after-effects-mcp-pro setup` once first: it installs the After Effects
listener (faster calls, no window focus changes). Without it the server still works in
direct mode.
