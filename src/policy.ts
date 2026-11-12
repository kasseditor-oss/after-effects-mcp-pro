// What this server exposes, from environment variables (see README "Security").
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef } from "./tools.js";

/** AE_MCP_EVAL=on|off (default on in 2.x; planned default off in 3.0). AE_MCP_DISABLE_EVAL=1 = off. */
export function evalEnabled(): boolean {
  if (process.env.AE_MCP_DISABLE_EVAL === "1") return false;
  return (process.env.AE_MCP_EVAL ?? "on").toLowerCase() !== "off";
}

/** AE_MCP_READONLY=1: only tools that read or preview. */
export function readOnlyMode(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AE_MCP_READONLY ?? "");
}

const READ_EXTRA = new Set(["bridge_status", "check_expressions"]);
export function isReadTool(d: ToolDef): boolean {
  return !!d.readOnly || /^(list_|get_|preview_)/.test(d.name) || READ_EXTRA.has(d.name);
}

// ------------------------------------------------------------------ toolsets
/** AE_MCP_TOOLSET=full|core|minimal: how many tools are LISTED (smaller = less model context).
 *  Unlisted tools still work when called by name or inside batch. */
export const TOOLSETS: Record<string, string[]> = {
  core: [
    "bridge_status", "get_project_info", "list_compositions", "get_composition", "create_composition", "set_composition_settings",
    "import_files", "add_item_to_comp", "create_text_layer", "create_shape_layer", "create_solid_layer", "create_null_layer", "create_camera",
    "list_layers", "get_layer_details", "set_layer_properties", "set_text", "get_property", "set_property", "set_keyframes",
    "animate_layer", "apply_effect", "apply_effect_template", "set_expression", "markers", "preview_frame", "preview_contact_sheet",
    "batch", "undo", "render_in_background", "save_project",
  ],
  minimal: ["bridge_status", "get_project_info", "list_layers", "get_property", "set_property", "set_keyframes", "batch", "preview_frame", "undo", "run_extendscript"],
};
export function toolset(): string {
  const v = (process.env.AE_MCP_TOOLSET ?? "full").toLowerCase();
  return TOOLSETS[v] ? v : "full";
}
export function listed(d: ToolDef): boolean {
  if (disabledReason(d)) return false;
  const set = TOOLSETS[toolset()];
  return !set || set.includes(d.name);
}

/** null when the tool may be used, otherwise the reason it is disabled. */
export function disabledReason(d: ToolDef): string | null {
  if (d.name === "run_extendscript" && !evalEnabled()) return "run_extendscript is disabled (AE_MCP_EVAL=off)";
  if (readOnlyMode() && !isReadTool(d)) return `${d.name} changes the project and this server runs with AE_MCP_READONLY=1`;
  return null;
}

export function policySummary() {
  return { toolset: toolset(), eval: evalEnabled() ? "on" : "off", readOnly: readOnlyMode(), allowedDirs: process.env.AE_MCP_ALLOWED_DIRS ? process.env.AE_MCP_ALLOWED_DIRS.split(";").filter(Boolean).length : null };
}

// ------------------------------------------------------------------ file paths
/** Arguments that name files or folders on disk, per tool. */
export const PATH_ARGS: Record<string, string[]> = {
  import_files: ["paths"],
  apply_preset_file: ["presetPath"],
  open_project: ["path"],
  save_project: ["path"],
  replace_footage: ["file"],
  modify_item: ["replaceWithFile"],
  add_to_render_queue: ["outputPath"],
  render_in_background: ["outputPath"],
  preview_frame: ["savePath"],
  render_png_sequence: ["outputPath"],
  export_mogrt: ["path"],
};

/** AE_MCP_ALLOWED_DIRS: ';'-separated folders; when set, every path must resolve inside one of them. */
export function allowedDirs(): string[] | null {
  const v = process.env.AE_MCP_ALLOWED_DIRS;
  if (!v || !v.trim()) return null;
  return v.split(";").map((d) => d.trim()).filter(Boolean).map((d) => realish(path.resolve(d)));
}

/** realpath of the longest existing prefix + the rest (so new output files can be checked too). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = fs.realpathSync.native(cur);
  } catch {
    /* keep */
  }
  return path.join(real, ...rest);
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** null when allowed. The message never says whether the file exists. */
export function pathViolation(p: string): string | null {
  const dirs = allowedDirs();
  if (!dirs) return null;
  const OUT = "Path outside AE_MCP_ALLOWED_DIRS";
  if (typeof p !== "string" || !p) return OUT;
  if (p.split(/[\\/]/).includes("..")) return OUT;
  const real = norm(realish(path.resolve(p.replace(/\[#+\]/g, "0000"))));
  return dirs.some((d) => {
    const dd = norm(d);
    return real === dd || real.startsWith(dd.endsWith(path.sep) ? dd : dd + path.sep);
  })
    ? null
    : OUT;
}

/** Checks every path argument of a tool call; returns the first violation. */
export function checkPaths(tool: string, args: any): string | null {
  for (const key of PATH_ARGS[tool] ?? []) {
    const v = args?.[key];
    for (const p of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      const bad = pathViolation(p);
      if (bad) return `${bad} (${tool}.${key})`;
    }
  }
  return null;
}
