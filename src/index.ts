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
// Kept as a direct dependency on purpose: the SDK's toJsonSchemaCompat wraps this same
// library but does not let us pass $refStrategy "none", so 12 tools would get "$ref"
// pointers in their input schemas (some MCP clients do not resolve them).
import { zodToJsonSchema } from "zod-to-json-schema";
import { AEError, Bridge, SERVER_VERSION } from "./bridge.js";
import { findInstalls } from "./env.js";
import { TOOLS, NODE_ONLY, OUTPUTS, type ToolDef } from "./tools.js";
import { checkPaths, disabledReason, listed, policySummary, toolset } from "./policy.js";
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

function outSchema(s: z.ZodTypeAny) {
  const js = zodToJsonSchema(s, { target: "jsonSchema7", $refStrategy: "none" }) as any;
  delete js.$schema;
  return js;
}

function jsonSchema(d: ToolDef) {
  const js = zodToJsonSchema(schemas.get(d.name)!, { target: "jsonSchema7", $refStrategy: "none" }) as any;
  delete js.$schema;
  delete js.additionalProperties;
  return js;
}

// core / minimal profiles trade argument prose for context: long parameter descriptions,
// duplicate keys and output schemas are left out of tools/list (full docs: ae://docs/<tool>).
const COMPACT = toolset() !== "full";
function compactSchema(js: any, toolName: string): any {
  const strip = (o: any): any => {
    if (Array.isArray(o)) return o.map(strip);
    if (!o || typeof o !== "object") return o;
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "description" && typeof v === "string") continue;
      out[k] = strip(v);
    }
    return out;
  };
  const c = strip(js);
  // rarely needed fields are not listed (still accepted: validation uses the full schema)
  for (const k of ["inPoint", "outPoint", "label", "anchorPoint", "threeD", "blendMode", "timeoutSeconds"]) if (c.properties && k in c.properties && !(c.required ?? []).includes(k)) delete c.properties[k];
  // create_shape_layer: list only the shapes[] form (the single-shape top-level form still works)
  if (toolName === "create_shape_layer" && c.properties) {
    const keep = new Set(["comp", "shapes", "name", "position", "anchor", "scale", "rotation", "opacity", "startTime", "duration", "parent"]);
    for (const k of Object.keys(c.properties)) if (!keep.has(k)) delete c.properties[k];
    const item = c.properties.shapes?.items?.properties;
    if (item) for (const k of ["fillOpacity", "strokeOpacity", "lineCap", "inTangents", "outTangents", "outerRadius", "innerRadius", "repeater", "rotation", "gradient"]) delete item[k];
  }
  return c;
}
const LISTED = TOOLS.filter((d) => listed(d)).map((d) => ({
  name: d.name,
  ...(COMPACT ? {} : { title: d.title }),
  description: d.docs ? `${d.description} Details: ae://docs/${d.name}` : d.description,
  inputSchema: COMPACT ? compactSchema(jsonSchema(d), d.name) : jsonSchema(d),
  ...(OUTPUTS[d.name] && !COMPACT ? { outputSchema: outSchema(OUTPUTS[d.name]) } : {}),
  annotations: {
    readOnlyHint: !!d.readOnly,
    destructiveHint: !!d.destructive,
    idempotentHint: !!d.readOnly,
    openWorldHint: false,
  },
  // No per-tool icons: 79 copies of a 14 KB data URI made tools/list 1.2 MB. The icon
  // lives in serverInfo, and the activity card embeds its own copy.
  // MCP Apps: Claude renders the After Effects activity card for every call
  // visibility defaults to model + app; the legacy flat key stays for older hosts (full profile)
  _meta: COMPACT ? { ui: { resourceUri: WIDGET_URI } } : { ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI },
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
// Jobs are also written to <bridge>/jobs/<id>.json (+ .log) so a restarted server still knows them.
const jobsDir = () => {
  const d = path.join(bridge.dir, "jobs");
  fs.mkdirSync(d, { recursive: true });
  return d;
};
function saveJob(j: RenderJob, pid?: number) {
  const file = path.join(jobsDir(), `${j.id}.json`);
  let prev: any = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* new */
  }
  fs.writeFileSync(file, JSON.stringify({ ...prev, id: j.id, comp: j.comp, output: j.output, started: j.started, ended: j.ended ?? null, status: j.status, exitCode: j.exitCode ?? null, ...(pid ? { pid } : {}), log: path.join(jobsDir(), `${j.id}.log`) }));
}
function pidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Jobs known on disk but not in memory (started by an earlier server process). */
function diskJobs(): RenderJob[] {
  const out: RenderJob[] = [];
  const d = jobsDir();
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      if (jobs.has(j.id)) continue;
      let log: string[] = [];
      try {
        log = fs.readFileSync(j.log, "utf8").split(/\r?\n/).filter((l: string) => l.trim());
      } catch {
        /* no log */
      }
      let status = j.status;
      if (status === "running" && !pidAlive(j.pid)) {
        // the process ended while no server was watching: judge by aerender's last lines
        status = log.some((l) => /Total Time Elapsed|Finished composition/i.test(l)) ? "done" : "error";
      }
      out.push({ id: j.id, comp: j.comp, output: j.output, started: j.started, ended: j.ended ?? undefined, status, exitCode: j.exitCode, log });
    } catch {
      /* ignore broken file */
    }
  }
  return out;
}

/** Wait until AE has finished writing each file (saveFrameToPng is asynchronous). */
async function waitForFiles(files: string[], timeoutMs = 90_000, report?: Progress) {
  const t0 = Date.now();
  const last = new Map<string, number>();
  const done = new Set<string>();
  while (done.size < files.length && Date.now() - t0 < timeoutMs) {
    for (const f of files) {
      if (done.has(f) || !fs.existsSync(f)) continue;
      const size = fs.statSync(f).size;
      if (size > 0 && last.get(f) === size) {
        done.add(f);
        report?.(done.size, files.length, `frame ${done.size}/${files.length}`);
      }
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
async function renderFrames(a: { comp?: string | number; times?: number[]; maxSize: number; format: ImageFormat; quality: number; columns?: number; labels?: boolean; keepPath?: string; background?: "comp" | "transparent" | "checker"; report?: Progress }) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const frames = path.join(bridge.dir, "frames");
  const info = await bridge.call<any>("render_frames", { comp: a.comp, times: a.times, outputDir: frames.split(path.sep).join("/"), prefix: tag, maxSize: a.maxSize, fullRes: !!a.keepPath }, { undo: false, timeoutMs: 180_000 });
  const files: string[] = info.frames.map((f: any) => f.file);
  try {
    try {
      await waitForFiles(files, 90_000, a.report);
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

async function nodeTool(name: string, a: any, report?: Progress): Promise<CallToolResult> {
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
      status.modes = policySummary();
      status.undoGroup = undoGroupState();
      const warn = bridge.listenerVersionWarning();
      if (warn) status.warning = warn;
      return ok(status);
    }
    case "begin_undo_group": {
      undoGroupState();
      const previous = closeUndoGroup("replaced");
      undoGroup = { name: a.name ?? "MCP group", steps: 0, opened: Date.now(), lastCall: Date.now() };
      return ok({ open: undoGroup.name, closedPrevious: previous });
    }
    case "end_undo_group": {
      undoGroupState();
      if (!undoGroup) return ok({ closed: null, note: "No group was open", lastClosed: closedGroup });
      const g = closeUndoGroup("ended")!;
      return ok({ closed: g.name, steps: g.steps, note: g.steps ? `The next undo (without steps) reverts these ${g.steps} step(s).` : "Nothing to undo in this group." });
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
      const data: any = { comp: r.info.comp, time: f.time, width: r.info.width, height: r.info.height, previewWidth: r.size?.width ?? r.info.width, previewHeight: r.size?.height ?? r.info.height, savedTo: a.savePath ?? null };
      if (r.info.clamped?.length) {
        data.clampedFrom = r.info.clamped[0].requested;
        data.warning = `Time ${r.info.clamped[0].requested}s is outside the comp; showed ${r.info.clamped[0].used}s instead.`;
      }
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
      // smaller cells for big sheets keep the image under ~200 KB; then the whole sheet is
      // capped at sheetMaxSize (maxSize alone is per frame: 6 x 1600 px made a 6412 px sheet)
      let cell = a.maxSize ?? (times.length > 6 ? 360 : 480);
      const sheetMax = a.sheetMaxSize ?? 2048;
      if (columns > 0) {
        const rows = Math.ceil(times.length / columns);
        const k = cell / Math.max(comp.width, comp.height);
        const sheetW = columns * comp.width * k + (columns - 1) * 4, sheetH = rows * comp.height * k + (rows - 1) * 4;
        const over = Math.max(sheetW, sheetH) / sheetMax;
        if (over > 1) cell = Math.max(32, Math.floor(cell / over) - 4);
      }
      const r = await renderFrames({ comp: comp.id, times, maxSize: cell, format: a.background === "transparent" ? "png" : a.format ?? "jpeg", quality: a.quality ?? (times.length > 6 ? 70 : 80), columns, labels: true, background: a.background, report });
      const content: CallToolResult["content"] = [];
      if (r.images.length === 1) content.push({ type: "image", ...r.images[0] });
      else r.images.forEach((im, i) => content.push({ type: "text", text: `t = ${times[i]}s` }, { type: "image", ...im }));
      return { ...ok({ comp: comp.name, times, layout: r.images.length === 1 ? "grid" : "separate", columns: r.images.length === 1 ? columns : null, sheetWidth: r.size?.width ?? null, sheetHeight: r.size?.height ?? null, cellMaxSize: cell }, content), _meta: { "after-effects/summary": `${times.length} frames de ${comp.name}` } };
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
      // stdin ignored: aerender must never wait for input
      const proc = spawn(install.aerender, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const job: RenderJob = { id, comp: a.comp, output: a.outputPath, started: Date.now(), status: "running", log: [], proc };
      saveJob(job, proc.pid);
      const logFile = path.join(jobsDir(), `${id}.log`);
      const onData = (b: Buffer) => {
        fs.appendFileSync(logFile, b);
        for (const line of b.toString().split(/\r?\n/)) if (line.trim()) job.log.push(line.trim());
        if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
      };
      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("close", (code) => {
        job.exitCode = code;
        job.ended = Date.now();
        job.status = code === 0 ? "done" : "error";
        // exit 0 without any real output file is not a success (seen once: only an empty temp .m4v)
        const dir = path.dirname(job.output), base = path.parse(job.output).name;
        const wrote = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(base) && !/\.(aep|m4v)$/i.test(f) && fs.statSync(path.join(dir, f)).size > 0);
        if (job.status === "done" && !wrote) {
          job.status = "error";
          job.log.push("aerender exited with code 0 but wrote no output file");
        }
        job.proc = undefined;
        saveJob(job);
      });
      proc.on("error", (e) => {
        job.status = "error";
        job.log.push(String(e));
      });
      jobs.set(id, job);
      if (!a.wait) return ok({ jobId: id, status: "running", command: [install.aerender, ...argv].join(" ") });
      // wait: stream progress from aerender's "PROGRESS: 0:00:01:05 (36): ..." lines
      let total = a.endFrame !== undefined ? a.endFrame - (a.startFrame ?? 0) + 1 : 0;
      if (!total) {
        const c = await bridge.call<any>("get_composition", { comp: a.comp, layerLimit: 0 }, { undo: false }).catch(() => null);
        if (c) total = Math.round(c.workAreaDuration * c.frameRate);
      }
      let lastFrame = -1;
      const deadline = Date.now() + (a.waitSeconds ?? 3600) * 1000;
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const line = [...job.log].reverse().find((l) => /PROGRESS:.*\((\d+)\)/.test(l));
        const frame = line ? Number(/\((\d+)\)/.exec(line)![1]) : -1;
        if (frame > lastFrame) {
          lastFrame = frame;
          report?.(frame - (a.startFrame ?? 0) + 1, total || undefined, `frame ${frame}`);
        }
      }
      return ok({ jobId: id, status: job.status, exitCode: job.exitCode ?? null, seconds: Math.round((Date.now() - job.started) / 1000), logTail: job.log.slice(-6) });
    }
    case "render_png_sequence": {
      const comp = await bridge.call<any>("get_composition", { comp: a.comp, layerLimit: 0 }, { undo: false });
      const fps = comp.frameRate;
      const first = a.startFrame ?? Math.round((a.start ?? comp.workAreaStart) * fps);
      const last = a.endFrame ?? (a.duration !== undefined ? first + Math.round(a.duration * fps) - 1 : Math.round((comp.workAreaStart + comp.workAreaDuration) * fps) - 1);
      if (last < first) return err(`Empty frame range ${first}-${last}`);
      if (last - first + 1 > 2000) return err(`${last - first + 1} frames requested; the limit is 2000`, "Render longer ranges with add_to_render_queue (TIFF sequence) or render_in_background.");
      const m = /\[(#+)\]/.exec(a.outputPath);
      const pad = m ? m[1].length : 4;
      const name = (n: number) => (m ? a.outputPath.replace(m[0], String(n).padStart(pad, "0")) : a.outputPath.replace(/(\.png)?$/i, `_${String(n).padStart(pad, "0")}.png`));
      const files: string[] = [];
      for (let n = first; n <= last; n++) files.push(path.resolve(name(n)));
      fs.mkdirSync(path.dirname(files[0]), { recursive: true });
      if (!a.overwrite) {
        const exists = files.filter((f) => fs.existsSync(f));
        if (exists.length) return err(`${exists.length} output file(s) already exist, e.g. ${exists[0]}`, "Pass overwrite:true to replace them.");
      }
      // chunks keep each AE call short and give progress between chunks
      const times = files.map((_, i) => +((first + i) / fps).toFixed(6));
      for (let i = 0; i < files.length; i += 50) {
        await bridge.call("render_frames", { comp: comp.id, times: times.slice(i, i + 50), names: files.slice(i, i + 50).map((f) => f.split(path.sep).join("/")), outputDir: "", prefix: "" }, { undo: false, timeoutMs: 300_000 });
        await waitForFiles(files.slice(i, i + 50), 300_000);
        report?.(Math.min(i + 50, files.length), files.length, `${Math.min(i + 50, files.length)}/${files.length} frames`);
      }
      return ok({ comp: comp.name, frames: files.length, firstFrame: first, lastFrame: last, first: files[0], last: files[files.length - 1] });
    }
    case "export_mogrt": {
      // the runtime starts the export; AE writes the file asynchronously
      const r = await bridge.call<any>("export_mogrt", a, { timeoutMs: 120_000 });
      const t0 = Date.now();
      let last = -1;
      while (Date.now() - t0 < 120_000) {
        if (fs.existsSync(r.file)) {
          const size = fs.statSync(r.file).size;
          if (size > 0 && size === last) break;
          last = size;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!fs.existsSync(r.file)) return err(`After Effects did not write ${r.file}`, "Check that the comp has Essential Graphics controllers and the folder is writable.");
      return ok({ ...r, bytes: fs.statSync(r.file).size });
    }
    case "get_background_render": {
      const all = [...jobs.values(), ...diskJobs()];
      const list = a.jobId ? all.filter((j) => j.id === a.jobId) : all;
      if (a.jobId && !list.length) return err(`No background render with id '${a.jobId}'`, all.length ? `Known jobs: ${all.map((j) => j.id).join(", ")}` : "No background renders are known.");
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
// ------------------------------------------------------------------ undo groups
// AE closes an undo group when a script run ends, so a group cannot span calls inside
// AE. The server counts the undo steps of the calls made while a group is open; the
// next undo without "steps" after end_undo_group reverts exactly that many.
const UNDO_IDLE_MS = 120_000;
const NOT_COUNTED = new Set(["undo", "begin_undo_group", "end_undo_group"]);
let undoGroup: { name: string; steps: number; opened: number; lastCall: number } | null = null;
let closedGroup: { name: string; steps: number } | null = null;
let undoneGroup: { name: string; steps: number } | null = null;
let lastChangeAt = 0;
// layers created by the last changing call, to verify that an undo really removed them
let lastCreated: number[] = [];
function createdIds(tool: string, data: any): number[] {
  if (!data) return [];
  if (tool.startsWith("create_") && typeof data.id === "number" && typeof data.index === "number") return [data.id];
  if (tool === "add_item_to_comp" && typeof data.id === "number") return [data.id];
  if (tool === "batch") {
    const t = data.tool;
    return (data.results ?? []).filter((r: any) => r.ok && typeof r.id === "number" && /^(create_|add_item_to_comp)/.test(r.tool ?? t ?? "")).map((r: any) => r.id);
  }
  return [];
}
function closeUndoGroup(reason: string) {
  if (!undoGroup) return null;
  closedGroup = { name: undoGroup.name, steps: undoGroup.steps };
  const g = { ...closedGroup, reason };
  undoGroup = null;
  return g;
}
function undoGroupState() {
  if (undoGroup && Date.now() - undoGroup.lastCall > UNDO_IDLE_MS) closeUndoGroup("idle");
  return { open: undoGroup ? { name: undoGroup.name, steps: undoGroup.steps, idleSeconds: Math.round((Date.now() - undoGroup.lastCall) / 1000) } : null, lastClosed: closedGroup };
}

const MAX_TEXT = 20_000;
function largeTextIssue(tool: string, a: any): string | null {
  if ((tool === "create_text_layer" || tool === "set_text") && typeof a.text === "string" && a.text.length > MAX_TEXT && !a.allowLargeText) {
    return `Text has ${a.text.length} characters; the limit is ${MAX_TEXT} without allowLargeText`;
  }
  return null;
}

/** Things a tool did NOT do although the call succeeded (missing files, unknown effect params). */
function partialWarnings(tool: string, data: any): string[] {
  if (!data) return [];
  if (tool === "import_files") return (data.errors ?? []).map((e: any) => `${e.path}: ${e.error}`);
  if (tool === "apply_effect") return (data.results ?? []).flatMap((r: any) => (r.errors ?? []).map((e: string) => `${r.layer}/${r.effect}: ${e}`));
  if (tool === "modify_effect") return (data.errors ?? []).map((e: string) => `${data.effect}: ${e}`);
  return [];
}

let versionChecked = false;
server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
  // MCP progress: only when the client sent a progressToken
  const token = (req.params as any)._meta?.progressToken;
  const report: Progress | undefined =
    token === undefined
      ? undefined
      : (progress, total, message) => {
          extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, ...(total ? { total } : {}), ...(message ? { message } : {}) } } as any).catch(() => undefined);
        };
  const result = await dispatch(req, extra.signal, report);
  // Read tools also return the JSON as structuredContent (their outputSchema documents it).
  if (OUTPUTS[req.params.name] && !result.isError && result.content?.[0]?.type === "text") {
    try {
      result.structuredContent = JSON.parse((result.content[0] as any).text);
    } catch {
      /* text was not JSON */
    }
  }
  if (!versionChecked && req.params.name !== "bridge_status") {
    versionChecked = true;
    const warn = bridge.listenerVersionWarning();
    if (warn) result.content = [...(result.content ?? []), { type: "text", text: `Warning: ${warn}` }];
  }
  return result;
});

type Progress = (progress: number, total?: number, message?: string) => void;

async function dispatch(req: { params: { name: string; arguments?: Record<string, unknown> } }, signal?: AbortSignal, report?: Progress): Promise<CallToolResult> {
  const name = req.params.name;
  const def = TOOLS.find((d) => d.name === name);
  if (!def) return err(`Unknown tool '${name}'`);
  const off = disabledReason(def);
  if (off) return err(off, "See README > Security for AE_MCP_EVAL / AE_MCP_READONLY.");
  const parsed = schemas.get(name)!.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return err(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const args: any = parsed.data;
  // File paths: AE_MCP_ALLOWED_DIRS sandbox (also for every batch operation), before anything reaches AE
  const badPath = checkPaths(name, args) ?? (name === "batch" ? args.operations.map((op: any) => checkPaths(op.tool, op.args ?? {})).find(Boolean) : null);
  if (badPath) return err(badPath);
  // never overwrite an existing output file silently
  const outArg = ({ add_to_render_queue: "outputPath", render_in_background: "outputPath", preview_frame: "savePath" } as Record<string, string>)[name];
  if (outArg && typeof args[outArg] === "string" && !args.overwrite && !/\[#+\]/.test(args[outArg]) && fs.existsSync(args[outArg])) {
    return err(`Output file already exists: ${args[outArg]}`, "Pass overwrite:true to replace it, or choose another path.");
  }
  // Huge texts freeze AE's UI for seconds: refuse them before they reach AE unless asked for.
  const big = largeTextIssue(name, args) ?? (name === "batch" ? args.operations.map((op: any) => largeTextIssue(op.tool, op.args ?? {})).find(Boolean) : null);
  if (big) return err(big, "Pass allowLargeText: true if you really need it (the default timeout then rises to 120 s), or split the text into several layers.");
  if ((name === "create_text_layer" || name === "set_text") && args.allowLargeText && !args.timeoutSeconds) args.timeoutSeconds = 120;
  try {
    if (NODE_ONLY.has(name)) return await nodeTool(name, args, report);
    if (name === "batch") {
      // validate every operation against its own schema before sending anything to AE
      for (const [i, op] of args.operations.entries()) {
        const s = schemas.get(op.tool);
        if (!s || NODE_ONLY.has(op.tool) || op.tool === "batch") return err(`batch operation ${i}: '${op.tool}' cannot run inside batch`);
        const opOff = disabledReason(TOOLS.find((d) => d.name === op.tool)!);
        if (opOff) return err(`batch operation ${i}: ${opOff}`);
        const p = s.safeParse(op.args ?? {});
        if (!p.success) return err(`batch operation ${i} (${op.tool}): ${p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        op.args = p.data;
      }
    }
    undoGroupState(); // auto-close an idle group
    // AE only registers a script's undo group once it is idle again: an Undo sent right
    // after a change (< 1 s) was sometimes ignored. Let it settle first.
    let verifyIds: number[] = [];
    if (name === "undo") {
      const wait = 1000 - (Date.now() - lastChangeAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if ((args.action ?? "undo") === "undo") verifyIds = lastCreated;
      lastCreated = [];
    }
    if (name === "undo" && args.steps === undefined && (args.action ?? "undo") === "undo") {
      if (undoGroup) closeUndoGroup("undo");
      if (closedGroup && closedGroup.steps > 0) {
        const g = closedGroup;
        closedGroup = null;
        args.steps = g.steps;
        const data = await bridge.call("undo", args, { undo: false, signal });
        undoneGroup = g; // a following redo without steps redoes the whole group
        return ok({ ...(data as object), group: g.name, note: `Reverted undo group '${g.name}' (${g.steps} step(s))` });
      }
    }
    if (name === "undo" && args.steps === undefined && args.action === "redo" && undoneGroup) {
      const g = undoneGroup;
      undoneGroup = null;
      args.steps = g.steps;
      const data = await bridge.call("undo", args, { undo: false, signal });
      closedGroup = g; // undo again reverts the group again
      return ok({ ...(data as object), group: g.name, note: `Redid undo group '${g.name}' (${g.steps} step(s))` });
    }
    let timeoutMs = def.timeoutMs ?? 60_000;
    if (args.timeoutSeconds) timeoutMs = args.timeoutSeconds * 1000;
    delete args.timeoutSeconds;
    // read-only tools change nothing: no undo group (it costs time and adds empty undo steps)
    const undo = name === "run_extendscript" ? args.undoable !== false : def.undo !== false && !def.readOnly;
    const data: any = await bridge.call(def.handler ?? name, args, { timeoutMs, undo, timeoutParam: true, signal, onProgress: report });
    // one AE undo step per successful changing call (an atomic batch that rolled back leaves none)
    if (undo) {
      lastChangeAt = Date.now();
      lastCreated = createdIds(name, data);
    }
    // plain one-step undo of a call that created layers: check they are really gone.
    // AE occasionally does not record a script's undo step (seen right after some batches).
    if (name === "undo" && (args.action ?? "undo") === "undo" && (args.steps ?? 1) === 1 && verifyIds.length) {
      const still = (await bridge.call<any>("layers_exist", { ids: verifyIds }, { undo: false })).existing;
      if (still.length) {
        return err(
          `After Effects did not undo the last change: ${still.length} layer(s) it created still exist (ids ${still.join(", ")})`,
          "AE sometimes does not record a script's undo step. Remove them with delete_layers (e.g. layers ['id:" + still[0] + "']) or use Edit > Undo in AE.",
        );
      }
    }
    if (undo && !NOT_COUNTED.has(name) && !(name === "batch" && data?.rolledBack)) {
      if (undoGroup) {
        undoGroup.steps++;
        undoGroup.lastCall = Date.now();
      } else closedGroup = null; // a new step after the group: "undo" means just this step again
      undoneGroup = null; // and the undone group can no longer be redone as a whole
    }
    // Partial results must not look like plain success to an agent that only reads isError.
    if (name === "import_files" && data && !data.imported?.length && data.errors?.length) {
      return err(`Nothing was imported: ${data.errors.map((e: any) => `${e.path}: ${e.error}`).join("; ")}`, "Check the paths (absolute, existing files).");
    }
    if (name === "set_expression" && data?.expressionError && args.failOnError !== false) {
      return err(`Expression error on ${data.property}: ${data.expressionError}`, "The expression was applied but disabled (as After Effects does). Fix it and call set_expression again, or pass failOnError:false.");
    }
    const warnings = partialWarnings(name, data);
    if (warnings.length) {
      const res = ok(data);
      (res.content[0] as any).text = `${warnings.length} warning(s): ${warnings.join("; ")}\n${(res.content[0] as any).text}`;
      return res;
    }
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
    // full documentation of every tool (long descriptions live here, not in tools/list)
    ...TOOLS.filter((d) => !disabledReason(d)).map((d) => ({ uri: `ae://docs/${d.name}`, name: `docs: ${d.name}`, mimeType: "text/markdown", description: d.title })),
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === WIDGET_URI) {
    return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml(CARD_ICON), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } } as any] };
  }
  if (req.params.uri.startsWith("ae://docs/")) {
    const d = TOOLS.find((t) => t.name === req.params.uri.slice("ae://docs/".length));
    if (!d) throw new Error(`Unknown tool ${req.params.uri}`);
    const md = `# ${d.name}: ${d.title}\n\n${d.docs ?? d.description}\n\n## Arguments\n\n\`\`\`json\n${JSON.stringify(jsonSchema(d), null, 1)}\n\`\`\`\n`;
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: md }] };
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
