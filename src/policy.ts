// What this server exposes, from environment variables (see README "Security").
import type { ToolDef } from "./tools.js";

/** AE_MCP_EVAL=on|off (default on in 2.x; planned default off in 3.0). AE_MCP_DISABLE_EVAL=1 = off. */
export function evalEnabled(): boolean {
  if (process.env.AE_MCP_DISABLE_EVAL === "1") return false;
  return (process.env.AE_MCP_EVAL ?? "on").toLowerCase() !== "off";
}

/** AE_MCP_READONLY=1: only tools that read or preview. */
export function readOnlyMode(): boolean {
  return process.env.AE_MCP_READONLY === "1";
}

const READ_EXTRA = new Set(["bridge_status", "check_expressions"]);
export function isReadTool(d: ToolDef): boolean {
  return !!d.readOnly || /^(list_|get_|preview_)/.test(d.name) || READ_EXTRA.has(d.name);
}

/** null when the tool may be used, otherwise the reason it is disabled. */
export function disabledReason(d: ToolDef): string | null {
  if (d.name === "run_extendscript" && !evalEnabled()) return "run_extendscript is disabled (AE_MCP_EVAL=off)";
  if (readOnlyMode() && !isReadTool(d)) return `${d.name} changes the project and this server runs with AE_MCP_READONLY=1`;
  return null;
}

export function policySummary() {
  return { eval: evalEnabled() ? "on" : "off", readOnly: readOnlyMode() };
}
