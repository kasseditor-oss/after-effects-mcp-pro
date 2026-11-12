#!/usr/bin/env node
// Generates docs/tools.md from the server's own tools/list (full profile): name, description,
// parameters with types, and one example call per tool.
//   npm run docs            write docs/tools.md
//   npm run docs -- --check fail when docs/tools.md is out of date (CI)
// Needs `npm run build` first. After Effects is never contacted.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "tools.md");

const env = { ...process.env, AE_MCP_PLATFORM: "other", AE_MCP_TOOLSET: "full", AE_MCP_EVAL: "on", AE_MCP_READONLY: "0" };
delete env.AE_MCP_DISABLE_EVAL;
const client = new Client({ name: "gen-docs", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "build", "index.js")], env, stderr: "ignore" }));
const { tools } = await client.listTools();
await client.close();

// Hand-written examples where a generated one would not show the idea.
const EXAMPLES = {
  batch: { operations: [{ tool: "create_text_layer", args: { comp: "Main", text: "Hello" } }, { tool: "animate_layer", args: { comp: "Main", layer: "Hello", preset: "fade-in" } }] },
  set_keyframes: { comp: "Main", layer: "Title", property: "Position", keyframes: [{ time: 0, value: [960, 700] }, { time: 0.6, value: [960, 540] }], easing: "easy-ease" },
  create_shape_layer: { comp: "Main", shapes: [{ type: "rectangle", size: [600, 120], fill: "#1e90ff", roundness: 20 }], name: "Bar" },
  create_text_layer: { comp: "Main", text: "LAUNCH DAY", fontSize: 120, color: "#ffffff", position: [960, 540] },
  create_composition: { name: "Main", preset: "1080p", duration: 10 },
  animate_layer: { comp: "Main", layer: "Title", preset: "text-fade-up", startTime: 0, duration: 0.8 },
  apply_effect: { comp: "Main", layer: "Title", effect: "Gaussian Blur", params: { Blurriness: 12 } },
  apply_effect_template: { comp: "Main", layer: "Title", template: "glow" },
  set_expression: { comp: "Main", layer: "Title", property: "Rotation", expression: "wiggle(2, 10)" },
  run_extendscript: { code: "return app.project.numItems;" },
  preview_contact_sheet: { comp: "Main", frames: 12 },
  preview_frame: { comp: "Main", time: 1.5 },
  render_in_background: { comp: "Main", outputPath: "C:/renders/main.mp4", preset: "mp4-h264-high", wait: true },
  set_time_remap: { comp: "Main", layer: "Clip", mode: "speed", speed: 2 },
  add_layer_style: { comp: "Main", layer: "Logo", style: "drop-shadow", params: { Distance: 12, Size: 20 } },
  modify_mask: { comp: "Main", layer: "Photo", mask: "Mask 1", feather: 40, keyframes: { property: "path", keys: [{ time: 0, value: { shape: "ellipse", rect: [0, 0, 200, 200] } }, { time: 1, value: { shape: "ellipse", rect: [0, 0, 1920, 1080] } }] } },
  import_files: { paths: ["C:/work/logo.png"], addToComp: "Main" },
  set_property: { comp: "Main", layer: "Title", property: "Opacity", value: 50 },
  get_property: { comp: "Main", layer: "Title", property: "Position" },
};

const SAMPLE_STRINGS = {
  comp: "Main", layer: "Title", property: "Position", name: "My layer", text: "Hello", newName: "Renamed", effect: "Gaussian Blur",
  item: "logo.png", query: "Title", font: "ArialMT", template: "glow", preset: "fade-in", code: "return 1;", expression: "time * 90",
  outputPath: "C:/renders/main.mp4", path: "C:/work/project.aep", projectPath: "C:/work/project.aep", presetPath: "C:/work/look.ffx",
  savePath: "C:/work/frame.png", folder: "Assets", mask: "Mask 1", matteLayer: "Matte", pathLayer: "Path", amplitudeLayer: "Audio Amplitude",
};

function example(schema, key) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf || schema.oneOf)[0], key);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "string") return SAMPLE_STRINGS[key] ?? (/path/i.test(key ?? "") ? "C:/work/file" : "text");
  if (type === "number" || type === "integer") {
    if (/time|start/i.test(key ?? "")) return 1;
    if (schema.minimum !== undefined && schema.minimum > 0) return schema.minimum;
    return 1;
  }
  if (type === "boolean") return true;
  if (type === "array") {
    if (/position|anchor|size/i.test(key ?? "")) return [960, 540];
    const it = example(schema.items, key && key.replace(/s$/, ""));
    const n = schema.minItems ?? 1;
    return Array.from({ length: Math.max(1, n) }, () => it);
  }
  if (type === "object") {
    const o = {};
    for (const k of schema.required ?? []) o[k] = example(schema.properties?.[k], k);
    return o;
  }
  return null;
}

function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf || s.oneOf) return (s.anyOf || s.oneOf).map(typeOf).join(" | ");
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (t === "array") {
    const len = s.minItems !== undefined && s.minItems === s.maxItems ? `${s.minItems}` : "";
    return `${typeOf(s.items)}[${len}]`;
  }
  if (t === "object" && s.properties) return "object";
  return t ?? "any";
}

const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const byCategory = new Map();
const { TOOLS } = await import(new URL("../build/tools.js", import.meta.url).href);
const cat = Object.fromEntries(TOOLS.map((t) => [t.name, t.category ?? "other"]));
for (const t of tools) {
  const c = cat[t.name] ?? "other";
  if (!byCategory.has(c)) byCategory.set(c, []);
  byCategory.get(c).push(t);
}

let md = `# Tool reference

Generated by \`npm run docs\` from the server's \`tools/list\` (${tools.length} tools, full profile). Do not edit by hand.

Every tool that runs inside After Effects also accepts \`timeoutSeconds\`. Layers can be addressed by index, name or \`id:<n>\`; comps by name or id (default: the active comp).

`;
for (const [c, list] of byCategory) md += `- **${c}:** ${list.map((t) => `[\`${t.name}\`](#${t.name})`).join(", ")}\n`;
for (const [c, list] of byCategory) {
  md += `\n## ${c[0].toUpperCase()}${c.slice(1)}\n`;
  for (const t of list) {
    const props = t.inputSchema?.properties ?? {};
    const req = new Set(t.inputSchema?.required ?? []);
    const hints = [t.annotations?.readOnlyHint ? "read-only" : null, t.annotations?.destructiveHint === false ? "non-destructive" : null].filter(Boolean);
    md += `\n### ${t.name}\n\n${t.title ? `**${t.title}.** ` : ""}${t.description}${hints.length ? ` *(${hints.join(", ")})*` : ""}\n\n`;
    const keys = Object.keys(props).filter((k) => k !== "timeoutSeconds");
    if (keys.length) {
      md += `| Parameter | Type | Required | Description |\n|---|---|---|---|\n`;
      for (const k of keys) md += `| \`${k}\` | ${esc(typeOf(props[k]))} | ${req.has(k) ? "yes" : ""} | ${esc(props[k].description)} |\n`;
      md += "\n";
    } else md += "No parameters.\n\n";
    // required parameters, plus comp/layer when the tool takes them (most calls name them)
    const shown = [...(t.inputSchema?.required ?? [])];
    for (const k of ["comp", "layer"]) if (props[k] && !shown.includes(k)) shown.unshift(k);
    for (const k of Object.keys(EXAMPLES[t.name] ?? {})) if (!props[k]) throw new Error(`example for ${t.name} uses unknown parameter '${k}'`);
    const ex = EXAMPLES[t.name] ?? example({ type: "object", required: shown, properties: props });
    md += "```json\n" + JSON.stringify({ name: t.name, arguments: ex }) + "\n```\n";
  }
}

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== md) {
    console.error("docs/tools.md is out of date: run npm run docs");
    process.exit(1);
  }
  console.log("docs/tools.md is up to date");
} else {
  fs.writeFileSync(out, md);
  console.log(`docs/tools.md written (${tools.length} tools)`);
}
