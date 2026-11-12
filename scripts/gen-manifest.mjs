#!/usr/bin/env node
// Writes manifest.json (Claude Desktop extension, MCPB format) from package.json and the
// tool list, so the bundle never drifts from the server. Run after `npm run build`.
// `--check` fails when the committed manifest.json is out of date (CI).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const { TOOLS } = await import(pathToFileURL(path.join(root, "build", "tools.js")).href);
const { TOOLSETS } = await import(pathToFileURL(path.join(root, "build", "policy.js")).href);
const repo = "https://github.com/kasseditor-oss/after-effects-mcp-pro";

const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "After Effects MCP Pro",
  version: pkg.version,
  description: "Drive Adobe After Effects from Claude: comps, layers, text, shapes, keyframes, effects, layer styles, previews and rendering.",
  long_description:
    "MCP server for Adobe After Effects (2022 or newer, Windows and macOS). Builds comps, layers, text, shapes, masks, keyframes, expressions, effects and layer styles; previews frames and contact sheets so Claude can look at the result; renders in the background with aerender. Run the setup once (`npx after-effects-mcp-pro setup`) to install the fast listener inside After Effects; without it the server uses direct mode.",
  author: { name: "kasseditor-oss", url: "https://github.com/kasseditor-oss" },
  repository: { type: "git", url: `${repo}.git` },
  homepage: repo,
  documentation: `${repo}#readme`,
  support: `${repo}/issues`,
  icon: "assets/icon-256.png",
  server: {
    type: "node",
    entry_point: "build/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/build/index.js"],
      env: { AE_MCP_TOOLSET: "${user_config.toolset}", AE_MCP_EVAL: "${user_config.eval}", AE_MCP_READONLY: "${user_config.read_only}" },
    },
  },
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  tools_generated: false,
  prompts_generated: true,
  keywords: ["after-effects", "adobe", "motion-design", "motion-graphics", "animation", "video"],
  license: pkg.license,
  user_config: {
    toolset: { type: "string", title: "Tool profile", description: `full (${TOOLS.length} tools), core (${TOOLSETS.core.length}) or minimal (${TOOLSETS.minimal.length}). Unlisted tools still work when called by name.`, default: "full", required: false },
    eval: { type: "string", title: "run_extendscript", description: "on or off. off hides the custom-script tool (recommended for shared setups).", default: "on", required: false },
    read_only: { type: "boolean", title: "Read-only mode", description: "Only list_, get_ and preview_ tools.", default: false, required: false },
  },
  compatibility: { platforms: ["win32", "darwin"], runtimes: { node: pkg.engines.node.replace(/^>=(\d+)$/, ">=$1.0.0") } },
};

const text = JSON.stringify(manifest, null, 2) + "\n";
const file = path.join(root, "manifest.json");
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== text) {
    console.error("manifest.json is out of date: run npm run manifest");
    process.exit(1);
  }
  console.log("manifest.json is up to date");
} else {
  fs.writeFileSync(file, text);
  console.log(`manifest.json written (${manifest.tools.length} tools, version ${manifest.version})`);
}
