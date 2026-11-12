/**
 * Command line: `after-effects-mcp-pro [--help | --version | setup [--uninstall]]`.
 * Without arguments the MCP server starts on stdio (what MCP clients run).
 */
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ENV_VARS: [string, string][] = [
  ["AE_MCP_TOOLSET", "full | core | minimal: how many tools are listed (default full)"],
  ["AE_MCP_EVAL", "on | off: run_extendscript (default on; AE_MCP_DISABLE_EVAL=1 = off)"],
  ["AE_MCP_READONLY", "1: only read tools (list_, get_, preview_)"],
  ["AE_MCP_ALLOWED_DIRS", "folders separated by ; that file tools may use (others are refused)"],
  ["AE_MCP_AE_PATH", "After Effects install folder, if auto-detect fails"],
  ["AE_MCP_MODE", "listener | direct: force the bridge mode"],
  ["AE_MCP_BRIDGE_DIR", "bridge folder (default %APPDATA%/ae-mcp-pro or ~/Library/Application Support/ae-mcp-pro)"],
  ["AE_MCP_PRETTY", "1: indented JSON in responses"],
  ["AE_MCP_ASSUME_AE_VERSION", "treat After Effects as this version (e.g. 23.0)"],
];

function help(version: string): string {
  return `After Effects MCP Pro ${version}
MCP server that lets Claude and other MCP clients drive Adobe After Effects.

Usage:
  after-effects-mcp-pro                 start the MCP server on stdio (what MCP clients run)
  after-effects-mcp-pro setup           install the After Effects side (listener, panel,
                                        scripting permission) and print the client config
  after-effects-mcp-pro setup --uninstall
                                        remove the listener startup script and the panel
  after-effects-mcp-pro --version       print the version
  after-effects-mcp-pro --help          this help

Environment variables:
${ENV_VARS.map(([k, v]) => `  ${k.padEnd(26)} ${v}`).join("\n")}

Docs: https://github.com/kasseditor-oss/after-effects-mcp-pro#readme
`;
}

function configSnippet(): string {
  return `Add the server to your MCP client:

  Claude Code:
    claude mcp add after-effects -- npx -y after-effects-mcp-pro

  Claude Desktop (claude_desktop_config.json):
    { "mcpServers": { "after-effects": { "command": "npx", "args": ["-y", "after-effects-mcp-pro"] } } }
`;
}

/** Handles CLI arguments. Returns true when the process should exit instead of serving MCP. */
export function runCli(argv: string[], buildDir: string, version: string): number | null {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return null;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(help(version));
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(version + "\n");
    return 0;
  }
  if (cmd === "setup") {
    const script = path.join(buildDir, "..", "scripts", "install-ae.mjs");
    const r = spawnSync(process.execPath, [script, ...rest], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status === 0 && !rest.includes("--uninstall")) process.stdout.write("\n" + configSnippet());
    return r.status ?? 1;
  }
  process.stderr.write(`Unknown argument '${cmd}'.\n\n${help(version)}`);
  return 2;
}
