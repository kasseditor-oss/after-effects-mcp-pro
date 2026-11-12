#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
    capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
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
}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LISTED as any }));

const ok = (data: unknown, extra: CallToolResult["content"] = []): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }, ...extra],
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

/** Downscale a PNG in place so its longest side is <= maxSize (OS tools, no npm deps). */
function resizePng(file: string, maxSize: number, w: number, h: number): { width: number; height: number } {
  if (Math.max(w, h) <= maxSize) return { width: w, height: h };
  const k = maxSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  try {
    if (process.platform === "win32") {
      const ps =
        "Add-Type -AssemblyName System.Drawing;" +
        `$s=[System.Drawing.Image]::FromFile('${file.replace(/'/g, "''")}');` +
        `$b=New-Object System.Drawing.Bitmap ${nw},${nh};$g=[System.Drawing.Graphics]::FromImage($b);` +
        "$g.InterpolationMode='HighQualityBicubic';" +
        `$g.DrawImage($s,0,0,${nw},${nh});$s.Dispose();$g.Dispose();` +
        `$b.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);$b.Dispose()`;
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 30_000 });
    } else if (process.platform === "darwin") {
      execFileSync("sips", ["-Z", String(maxSize), file], { timeout: 30_000 });
    } else return { width: w, height: h };
    return { width: nw, height: nh };
  } catch {
    return { width: w, height: h }; // keep full size if resizing fails
  }
}

async function captureFrame(args: { comp?: string | number; time?: number; maxSize?: number }, keepPath?: string) {
  const file = path.join(bridge.dir, "frames", `frame-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  const info = await bridge.call<any>("render_frame", { comp: args.comp, time: args.time, outputPath: file.split(path.sep).join("/") }, { undo: false, timeoutMs: 120_000 });
  // saveFrameToPng returns before the PNG is written: wait until the file exists and its size is stable
  let last = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0 && size === last) break;
      last = size;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!fs.existsSync(file)) throw new AEError("After Effects did not write the frame in time", "AE may be busy. Try again or a lower resolution comp.");
  if (keepPath) fs.copyFileSync(file, keepPath);
  const size = resizePng(file, args.maxSize ?? 960, info.width, info.height);
  const data = fs.readFileSync(file).toString("base64");
  fs.rmSync(file, { force: true });
  return { info: { ...info, file: undefined, previewWidth: size.width, previewHeight: size.height }, data };
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
      return ok(status);
    }
    case "launch_after_effects": {
      const r = await bridge.launch(a.waitSeconds ?? 180);
      const ping = await bridge.call("ping", {}, { undo: false });
      return ok({ ...r, ae: ping });
    }
    case "preview_frame": {
      const { info, data } = await captureFrame(a, a.savePath);
      return ok({ ...info, savedTo: a.savePath ?? null }, [{ type: "image", data, mimeType: "image/png" }]);
    }
    case "preview_contact_sheet": {
      const comp = await bridge.call<any>("get_composition", { comp: a.comp }, { undo: false });
      let times: number[] = a.times;
      if (!times?.length) {
        const n = a.frames ?? 6;
        const start = comp.workAreaStart, dur = comp.workAreaDuration;
        times = Array.from({ length: n }, (_, i) => +(start + (dur * i) / (n - 1) - (i === n - 1 ? 1 / comp.frameRate : 0)).toFixed(3));
      }
      const images: CallToolResult["content"] = [];
      for (const time of times) {
        const { data } = await captureFrame({ comp: comp.id, time, maxSize: a.maxSize ?? 480 });
        images.push({ type: "text", text: `t = ${time}s` }, { type: "image", data, mimeType: "image/png" });
      }
      return ok({ comp: comp.name, times }, images);
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
server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const name = req.params.name;
  const def = TOOLS.find((d) => d.name === name);
  if (!def) return err(`Unknown tool '${name}'`);
  const parsed = schemas.get(name)!.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    return err(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const args: any = parsed.data;
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
    const undo = name === "run_extendscript" ? args.undoable !== false : def.undo !== false;
    const data: any = await bridge.call(def.handler ?? name, args, { timeoutMs, undo });
    if (name === "batch" && data?.failed > 0) {
      const first = data.results.find((r: any) => !r.ok);
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `Error: batch operation ${first?.index} (${first?.tool}) failed: ${first?.error}` +
            (first?.hint ? `\nHint: ${first.hint}` : "") +
            "\n" +
            (data.rolledBack ? "The whole batch was undone (atomic)." : `${data.executed - data.failed} earlier operation(s) stay applied as one undo step; call undo to revert them.`) +
            `\n${JSON.stringify(data)}`,
        }],
      };
    }
    return ok(data);
  } catch (e: any) {
    if (e instanceof AEError) return err(e.message, e.hint);
    return err(String(e?.message ?? e));
  }
});

// ------------------------------------------------------------------ resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "aftereffects://project", name: "Project info", mimeType: "application/json", description: "Current project overview" },
    { uri: "aftereffects://compositions", name: "Compositions", mimeType: "application/json", description: "All compositions" },
    { uri: "aftereffects://selection", name: "Selection", mimeType: "application/json", description: "Active comp and selected layers" },
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const map: Record<string, string> = { "aftereffects://project": "get_project_info", "aftereffects://compositions": "list_compositions", "aftereffects://selection": "get_selection" };
  const tool = map[req.params.uri];
  if (!tool) throw new Error(`Unknown resource ${req.params.uri}`);
  const data = await bridge.call(tool, {}, { undo: false });
  return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] };
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
