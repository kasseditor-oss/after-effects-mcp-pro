#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AEError, Bridge, SERVER_VERSION } from "./bridge.js";
import { findInstalls } from "./env.js";
import { TOOLS, NODE_ONLY, type ToolDef } from "./tools.js";
import { compose, type ImageFormat } from "./imaging.js";
import { WIDGET_MIME, WIDGET_URI, widgetHtml } from "./widget.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ icons
// The icon is what MCP clients (Claude Desktop / claude.ai / Claude Code) show
// next to the server and each tool call, like the badge other connectors have.
function loadIcons() {
  const icons: { src: string; mimeType: string; sizes?: string[] }[] = [];
  const dirs = [path.join(here, "..", "assets"), path.join(here, "assets")];
  for (const d of dirs) {
    for (const [file, size] of [["icon-256.png", "256x256"], ["icon-64.png", "64x64"], ["icon-32.png", "32x32"]] as const) {
      const p = path.join(d, file);
      if (fs.existsSync(p)) icons.push({ src: `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`, mimeType: "image/png", sizes: [size] });
    }
    const svg = path.join(d, "icon.svg");
    if (fs.existsSync(svg)) icons.push({ src: `data:image/svg+xml;base64,${fs.readFileSync(svg).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] });
    if (icons.length) break;
  }
  return icons;
}
const ICONS = loadIcons();

// ------------------------------------------------------------------ server
const server = new Server(
  {
    name: "after-effects",
    title: "After Effects",
    version: SERVER_VERSION,
    websiteUrl: "https://github.com/kasseditor-oss/after-effects-mcp-pro",
    ...(ICONS.length ? { icons: ICONS } : {}),
  } as any,
  {
    capabilities: { tools: {}, resources: {}, prompts: {}, logging: {}, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [WIDGET_MIME] } } } as any,
    instructions:
      "Controls a live Adobe After Effects session. Workflow tips: call get_selection or get_project_info first to see context; " +
      "address layers by 'id:<n>' when you will reorder them; use batch to build many things in one undo step; " +
      "after building, use preview_frame / preview_contact_sheet to LOOK at the result and fix issues. Times are in seconds, colors '#RRGGBB'. " +
      "Every call is one undo step (undo tool reverts it).",
  },
);

const bridge = new Bridge();
const schemas = new Map<string, z.ZodObject<any>>();
for (const d of TOOLS) schemas.set(d.name, z.object(d.shape).strict());

function jsonSchema(d: ToolDef) {
  const js = zodToJsonSchema(schemas.get(d.name)!, { target: "jsonSchema7", $refStrategy: "none" }) as any;
  delete js.$schema;
  delete js.additionalProperties;
  return js;
}

const LISTED = TOOLS.filter((d) => !(d.name === "run_extendscript" && process.env.AE_MCP_DISABLE_EVAL === "1")).map((d) => ({
  name: d.name,
  title: d.title,
  description: d.description,
  inputSchema: jsonSchema(d),
  annotations: {
    title: d.title,
    readOnlyHint: !!d.readOnly,
    destructiveHint: !!d.destructive,
    idempotentHint: !!d.readOnly,
    openWorldHint: false,
  },
  ...(ICONS.length ? { icons: ICONS } : {}),
  // MCP Apps: Claude renders the After Effects activity card for every call
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] }, "ui/resourceUri": WIDGET_URI },
}));
const CARD_ICON = (ICONS.find((i) => i.sizes?.includes("64x64")) ?? ICONS.find((i) => i.mimeType === "image/svg+xml") ?? ICONS[0])?.src ?? "";

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LISTED as any }));

// Compact JSON saves ~15-25% of tokens on every response; AE_MCP_PRETTY=1 for humans.
const PRETTY = process.env.AE_MCP_PRETTY === "1";
const toJson = (data: unknown) => (PRETTY ? JSON.stringify(data, null, 1) : JSON.stringify(data));

const ok = (data: unknown, extra: CallToolResult["content"] = []): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : toJson(data) }, ...extra],
});
const err = (message: string, hint?: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: hint ? `Error: ${message}\nHint: ${hint}` : `Error: ${message}` }],
});

// ------------------------------------------------------------------ node-side tools
interface RenderJob {
  id: string;
  comp: string;
  output: string;
  started: number;
  ended?: number;
  status: "running" | "done" | "error";
  exitCode?: number | null;
  log: string[];
  proc?: ChildProcess;
}
const jobs = new Map<string, RenderJob>();

/** Wait until AE has finished writing each file (saveFrameToPng is asynchronous). */
async function waitForFiles(files: string[], timeoutMs = 90_000) {
  const t0 = Date.now();
  const last = new Map<string, number>();
  const done = new Set<string>();
  while (done.size < files.length && Date.now() - t0 < timeoutMs) {
    for (const f of files) {
      if (done.has(f) || !fs.existsSync(f)) continue;
      const size = fs.statSync(f).size;
      if (size > 0 && last.get(f) === size) done.add(f);
      last.set(f, size);
    }
    if (done.size < files.length) await new Promise((r) => setTimeout(r, 100));
  }
  const missing = files.filter((f) => !done.has(f));
  if (missing.length) throw new AEError(`After Effects did not write ${missing.length} frame(s) in time`, "AE may be busy. Try again with fewer frames.");
}

/**
 * Render frames in one AE round trip, then resize / tile / encode them in one
 * image process. columns: 0 = return each frame separately.
 */
async function renderFrames(a: { comp?: string | number; times?: number[]; maxSize: number; format: ImageFormat; quality: number; columns?: number; labels?: boolean; keepPath?: string; background?: "comp" | "transparent" | "checker" }) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const frames = path.join(bridge.dir, "frames");
  const info = await bridge.call<any>("render_frames", { comp: a.comp, times: a.times, outputDir: frames.split(path.sep).join("/"), prefix: tag, maxSize: a.maxSize, fullRes: !!a.keepPath }, { undo: false, timeoutMs: 180_000 });
  const files: string[] = info.frames.map((f: any) => f.file);
  try {
    try {
      await waitForFiles(files);
    } finally {
      if (info.restoreResolution) await bridge.call("restore_resolution", { comp: info.compId, resolution: info.restoreResolution }, { undo: false }).catch(() => undefined);
    }
    if (a.keepPath) {
      fs.mkdirSync(path.dirname(a.keepPath), { recursive: true });
      fs.copyFileSync(files[0], a.keepPath);
    }
    const ext = a.format === "jpeg" ? "jpg" : "png";
    const mime = a.format === "jpeg" ? "image/jpeg" : "image/png";
    const columns = files.length === 1 ? 1 : a.columns ?? 4;
    if (columns > 0) {
      const out = path.join(frames, `${tag}-out.${ext}`);
      const labels = a.labels ? info.frames.map((f: any) => `${f.time}s`) : undefined;
      const bgMode = a.background ?? "comp";
      const background = bgMode === "checker" ? { type: "checker" as const } : bgMode === "transparent" ? { type: "none" as const } : { type: "color" as const, rgb: info.bgColor };
      const size = compose({ files, labels, maxSize: a.maxSize, columns, format: a.format, quality: a.quality, output: out, background }, frames);
      if (size) {
        const data = fs.readFileSync(out).toString("base64");
        fs.rmSync(out, { force: true });
        return { info, images: [{ data, mimeType: mime }], size };
      }
    }
    // separate layout, or no image tool on this OS: send each frame as rendered (PNG)
    return { info, images: files.map((f) => ({ data: fs.readFileSync(f).toString("base64"), mimeType: "image/png" })), size: null };
  } finally {
    // AE can still hold a file for a moment after writing it: cleanup is best-effort
    for (const f of files) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* removed by the hourly cleanup */
      }
    }
  }
}

async function nodeTool(name: string, a: any): Promise<CallToolResult> {
  switch (name) {
    case "bridge_status": {
      const installs = findInstalls();
      const hb = bridge.heartbeat();
      const running = bridge.aeRunning();
      const status: any = {
        server: SERVER_VERSION,
        bridgeDir: bridge.dir,
        installs: installs.map((i) => ({ version: i.version, path: i.appDir, aerender: !!i.aerender })),
        afterEffectsRunning: running,
        listener: hb ? { alive: hb.ageMs < 4000, lastHeartbeatMsAgo: hb.ageMs, paused: hb.paused, executed: hb.executed, version: hb.version } : "not installed (run: npm run install-ae) - direct mode will be used",
      };
      if (running) {
        try {
          status.ae = await bridge.call("ping", {}, { undo: false, timeoutMs: 15_000 });
          status.mode = bridge.lastMode;
        } catch (e: any) {
          status.error = e.message;
          status.hint = e.hint;
        }
      }
      status.diagnostics = bridge.diagnostics();
      const warn = bridge.listenerVersionWarning();
      if (warn) status.warning = warn;
      return ok(status);
    }
    case "launch_after_effects": {
      const r = await bridge.launch(a.waitSeconds ?? 180);
      const ping = await bridge.call("ping", {}, { undo: false });
      return ok({ ...r, ae: ping });
    }
    case "preview_frame": {
      // transparency needs PNG
      const fmt = a.background === "transparent" ? "png" : a.format ?? "jpeg";
      const r = await renderFrames({ comp: a.comp, times: a.time === undefined ? undefined : [a.time], maxSize: a.maxSize ?? 960, format: fmt, quality: a.quality ?? 85, keepPath: a.savePath, background: a.background });
      const f = r.info.frames[0];
      const data = { comp: r.info.comp, time: f.time, width: r.info.width, height: r.info.height, previewWidth: r.size?.width ?? r.info.width, previewHeight: r.size?.height ?? r.info.height, savedTo: a.savePath ?? null };
      return { ...ok(data, r.images.map((im) => ({ type: "image" as const, ...im }))), _meta: { "after-effects/summary": `Frame ${f.time}s de ${r.info.comp}` } };
    }
    case "preview_contact_sheet": {
      const comp = await bridge.call<any>("get_composition", { comp: a.comp, layerLimit: 0 }, { undo: false });
      let times: number[] = a.times;
      if (!times?.length) {
        const n = a.frames ?? 6;
        const start = comp.workAreaStart, dur = comp.workAreaDuration;
        times = Array.from({ length: n }, (_, i) => +(start + (dur * i) / (n - 1) - (i === n - 1 ? 1 / comp.frameRate : 0)).toFixed(3));
      }
      const columns = (a.layout ?? "grid") === "grid" ? Math.min(4, times.length) : 0;
      // smaller cells for big sheets keep the image under ~200 KB
      const cell = a.maxSize ?? (times.length > 6 ? 360 : 480);
      const r = await renderFrames({ comp: comp.id, times, maxSize: cell, format: a.background === "transparent" ? "png" : a.format ?? "jpeg", quality: a.quality ?? (times.length > 6 ? 70 : 80), columns, labels: true, background: a.background });
      const content: CallToolResult["content"] = [];
      if (r.images.length === 1) content.push({ type: "image", ...r.images[0] });
      else r.images.forEach((im, i) => content.push({ type: "text", text: `t = ${times[i]}s` }, { type: "image", ...im }));
      return { ...ok({ comp: comp.name, times, layout: r.images.length === 1 ? "grid" : "separate", columns: r.images.length === 1 ? columns : null }, content), _meta: { "after-effects/summary": `${times.length} frames de ${comp.name}` } };
    }
    case "render_in_background": {
      const install = findInstalls().find((i) => i.aerender);
      if (!install?.aerender) return err("aerender not found", "It ships with After Effects; set AE_MCP_AE_PATH.");
      const saved = await bridge.call<any>("save_project", {}, { undo: false }).catch((e) => {
        throw new AEError(`Project must be saved before background rendering: ${e.message}`, "Call save_project with a path first.");
      });
      const id = Math.random().toString(36).slice(2, 8);
      const argv = ["-project", saved.file, "-comp", a.comp, "-output", a.outputPath];
      if (a.outputModuleTemplate) argv.push("-OMtemplate", a.outputModuleTemplate);
      if (a.renderSettingsTemplate) argv.push("-RStemplate", a.renderSettingsTemplate);
      if (a.startFrame !== undefined) argv.push("-s", String(a.startFrame));
      if (a.endFrame !== undefined) argv.push("-e", String(a.endFrame));
      const proc = spawn(install.aerender, argv, { windowsHide: true });
      const job: RenderJob = { id, comp: a.comp, output: a.outputPath, started: Date.now(), status: "running", log: [], proc };
      const onData = (b: Buffer) => {
        for (const line of b.toString().split(/\r?\n/)) if (line.trim()) job.log.push(line.trim());
        if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("close", (code) => {
        job.exitCode = code;
        job.ended = Date.now();
        job.status = code === 0 ? "done" : "error";
        job.proc = undefined;
      });
      proc.on("error", (e) => {
        job.status = "error";
        job.log.push(String(e));
      });
      jobs.set(id, job);
      return ok({ jobId: id, status: "running", command: [install.aerender, ...argv].join(" ") });
    }
    case "get_background_render": {
      const list = a.jobId ? [jobs.get(a.jobId)].filter(Boolean) : [...jobs.values()];
      if (!list.length) return ok({ jobs: [] });
      return ok({
        jobs: list.map((j) => {
          const prog = [...j!.log].reverse().find((l) => /PROGRESS:\s+\d/.test(l));
          const dir = path.dirname(j!.output), base = path.parse(j!.output).name;
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(base) && !f.endsWith(".aep")).map((f) => path.join(dir, f)) : [];
          return { id: j!.id, comp: j!.comp, output: j!.output, outputFiles: files, status: j!.status, exitCode: j!.exitCode, seconds: Math.round(((j!.ended ?? Date.now()) - j!.started) / 1000), lastProgress: prog ?? null, logTail: j!.log.slice(-12) };
        }),
      });
    }
  }
  return err(`Unknown tool ${name}`);
}

// ------------------------------------------------------------------ dispatcher
const MAX_TEXT = 20_000;
function largeTextIssue(tool: string, a: any): string | null {
  if ((tool === "create_text_layer" || tool === "set_text") && typeof a.text === "string" && a.text.length > MAX_TEXT && !a.allowLargeText) {
    return `Text has ${a.text.length} characters; the limit is ${MAX_TEXT} without allowLargeText`;
  }
  return null;
}

let versionChecked = false;
server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
  const result = await dispatch(req, extra.signal);
  if (!versionChecked && req.params.name !== "bridge_status") {
    versionChecked = true;
    const warn = bridge.listenerVersionWarning();
    if (warn) result.content = [...(result.content ?? []), { type: "text", text: `Warning: ${warn}` }];
  }
  return result;
});

async function dispatch(req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal): Promise<CallToolResult> {
  const name = req.params.name;
  const def = TOOLS.find((d) => d.name === name);
  if (!def) return err(`Unknown tool '${name}'`);
  const parsed = schemas.get(name)!.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return err(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const args: any = parsed.data;
  // Huge texts freeze AE's UI for seconds: refuse them before they reach AE unless asked for.
  const big = largeTextIssue(name, args) ?? (name === "batch" ? args.operations.map((op: any) => largeTextIssue(op.tool, op.args ?? {})).find(Boolean) : null);
  if (big) return err(big, "Pass allowLargeText: true if you really need it (the default timeout then rises to 120 s), or split the text into several layers.");
  if ((name === "create_text_layer" || name === "set_text") && args.allowLargeText && !args.timeoutSeconds) args.timeoutSeconds = 120;
  try {
    if (NODE_ONLY.has(name)) return await nodeTool(name, args);
    if (name === "run_extendscript" && process.env.AE_MCP_DISABLE_EVAL === "1") return err("run_extendscript is disabled (AE_MCP_DISABLE_EVAL=1)");
    if (name === "batch") {
      // validate every operation against its own schema before sending anything to AE
      for (const [i, op] of args.operations.entries()) {
        const s = schemas.get(op.tool);
        if (!s || NODE_ONLY.has(op.tool) || op.tool === "batch") return err(`batch operation ${i}: '${op.tool}' cannot run inside batch`);
        const p = s.safeParse(op.args ?? {});
        if (!p.success) return err(`batch operation ${i} (${op.tool}): ${p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        op.args = p.data;
      }
    }
    let timeoutMs = def.timeoutMs ?? 60_000;
    if (args.timeoutSeconds) timeoutMs = args.timeoutSeconds * 1000;
    delete args.timeoutSeconds;
    // read-only tools change nothing: no undo group (it costs time and adds empty undo steps)
    const undo = name === "run_extendscript" ? args.undoable !== false : def.undo !== false && !def.readOnly;
    const data: any = await bridge.call(def.handler ?? name, args, { timeoutMs, undo, timeoutParam: true, signal });
    if (name === "batch" && data?.failed > 0) {
      const first = data.results.find((r: any) => !r.ok);
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `Error: batch operation ${first?.index} (${first?.tool}) failed: ${first?.error}` +
            (data.hint ? `\nHint: ${data.hint}` : "") +
            "\n" +
            (data.rolledBack ? "The whole batch was undone (atomic)." : `${data.executed - data.failed} earlier operation(s) stay applied as one undo step; call undo to revert them.`) +
            // hint already shown above: keep it out of the JSON
            `\n${JSON.stringify({ ...data, hint: undefined })}`,
        }],
      };
    }
    return ok(data);
  } catch (e: any) {
    if (e instanceof AEError) return err(e.message, e.hint);
    return err(String(e?.message ?? e));
  }
}

// ------------------------------------------------------------------ resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: WIDGET_URI, name: "After Effects activity", title: "After Effects activity", mimeType: WIDGET_MIME, description: "Inline card showing what Claude is doing in After Effects", _meta: { ui: { prefersBorder: false } } } as any,
    { uri: "aftereffects://project", name: "Project info", mimeType: "application/json", description: "Current project overview" },
    { uri: "aftereffects://compositions", name: "Compositions", mimeType: "application/json", description: "All compositions" },
    { uri: "aftereffects://selection", name: "Selection", mimeType: "application/json", description: "Active comp and selected layers" },
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === WIDGET_URI) {
    return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml(CARD_ICON), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } } as any] };
  }
  const map: Record<string, string> = { "aftereffects://project": "get_project_info", "aftereffects://compositions": "list_compositions", "aftereffects://selection": "get_selection" };
  const tool = map[req.params.uri];
  if (!tool) throw new Error(`Unknown resource ${req.params.uri}`);
  const data = await bridge.call(tool, {}, { undo: false });
  return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: toJson(data) }] };
});

// ------------------------------------------------------------------ prompts
const PROMPTS: Record<string, { description: string; args: { name: string; description: string; required?: boolean }[]; text: (a: Record<string, string>) => string }> = {
  "lower-third": {
    description: "Build an animated lower third (name + title) in the active comp",
    args: [{ name: "name", description: "Person name", required: true }, { name: "title", description: "Role / subtitle" }],
    text: (a) => `In After Effects, build a clean animated lower third in the active composition for "${a.name}"${a.title ? ` - "${a.title}"` : ""}. Use a shape-layer bar (Trim Paths reveal), two text layers with text-fade-up, a null to move it all, keep it in the lower-left safe area, and finish by checking it with preview_contact_sheet.`,
  },
  "kinetic-title": {
    description: "Create a kinetic typography title sequence",
    args: [{ name: "text", description: "Words of the title", required: true }, { name: "style", description: "Mood, e.g. energetic, elegant" }],
    text: (a) => `Create a new 1080p comp and a kinetic typography sequence for: "${a.text}". Style: ${a.style || "energetic"}. One text layer per word, staggered with sequence_layers, varied presets (pop, slide-in, text-fade-up), a subtle background, and motion blur. Preview with preview_contact_sheet and fix anything that overlaps.`,
  },
  "analyze-comp": {
    description: "Audit a composition for problems",
    args: [{ name: "comp", description: "Composition name" }],
    text: (a) => `Analyze the After Effects composition ${a.comp ? `"${a.comp}"` : "that is active"}: list layers, find broken expressions (check_expressions), missing footage (list_project_items), layers outside the comp duration, and anything off-frame (preview_frame). Report issues and offer fixes.`,
  },
};
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, description: p.description, arguments: p.args })),
}));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS[req.params.name];
  if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
  return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text((req.params.arguments as any) ?? {}) } }] };
});

// ------------------------------------------------------------------ start
async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`After Effects MCP ${SERVER_VERSION} ready - ${TOOLS.length} tools, bridge dir ${bridge.dir}`);
}
main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
