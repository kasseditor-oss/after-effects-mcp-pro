// Redo of the 5 QA tasks (2026-11-12 report) with 2.2.0, as an agent would: counts calls,
// saves a contact sheet per task in docs/qa-2026-11-12/after/.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "file:///D:/antigravity/Mcp%20After%20effects/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///D:/antigravity/Mcp%20After%20effects/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const REPO = "D:/antigravity/Mcp After effects";
const OUT = path.join(REPO, "docs", "qa-2026-11-12", "after");
const WORK = path.join(os.tmpdir(), "aemcp-qa-after");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const FFBIN = "C:/Users/Usuario/AppData/Local/Microsoft/WinGet/Packages/yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-126374-g089a48eb36-win64-gpl/bin";

const c = new Client({ name: "qa-after", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "build", "index.js")], stderr: "ignore" }));

const report = [];
let task = null;
async function call(name, args = {}, { quiet } = {}) {
  const t = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const ms = Date.now() - t;
  if (task) { task.calls++; task.ms += ms; task.log.push(`${name} ${ms} ms${r.isError ? " ERROR" : ""}`); }
  const text = r.content.find((x) => x.type === "text")?.text ?? "";
  if (r.isError && !quiet) console.log(`  ERROR ${name}: ${text.slice(0, 300)}`);
  let data = null;
  try { data = JSON.parse(text.replace(/^\d+ warning\(s\):[^\n]*\n/, "")); } catch { /* not json */ }
  return { r, data, text, ms };
}
async function sheet(comp, file, frames = 8) {
  const res = await call("preview_contact_sheet", { comp, frames });
  const img = res.r.content.find((x) => x.type === "image");
  fs.writeFileSync(path.join(OUT, file), Buffer.from(img.data, "base64"));
  const meta = res.r.content.filter((x) => x.type === "text").map((x) => x.text).join(" ").slice(0, 200);
  return { kb: Math.round(img.data.length * 0.75 / 1024), meta };
}
function begin(id, title) { task = { id, title, calls: 0, ms: 0, log: [], notes: [] }; console.log(`\n== ${id} ${title}`); }
function end(extra) { Object.assign(task, extra); report.push(task); console.log(`   ${task.calls} calls, ${(task.ms / 1000).toFixed(1)} s`); task = null; }

// ---------------------------------------------------------------- setup (not counted)
const st = (await call("bridge_status")).data;
console.log("server", st.server, "listener", st.listener?.version, "mode", st.mode, "ae", st.compatibility?.aeVersion);
await call("save_project", { path: path.join(WORK, "qa-after.aep"), overwrite: true });

// ---------------------------------------------------------------- A1 lower third
begin("A1", "Lower third 1080p");
{
  const comp = (await call("create_composition", { name: "QA A1 Lower Third", preset: "1080p", duration: 5, backgroundColor: "#1b2330", open: false })).data;
  const b = await call("batch", { operations: [
    { tool: "create_null_layer", args: { comp: comp.id, name: "LT Controller", position: [160, 860] } },
    { tool: "create_shape_layer", args: { comp: comp.id, name: "Plate", shapes: [{ type: "rectangle", size: [760, 150], fill: "#ffffff", fillOpacity: 92, roundness: 10 }], anchor: "left", position: [160, 860], parent: "LT Controller" } },
    { tool: "create_shape_layer", args: { comp: comp.id, name: "Accent", shapes: [{ type: "rectangle", size: [10, 150], fill: "#ff3b5c" }], anchor: "left", position: [160, 860], parent: "LT Controller" } },
    { tool: "create_shape_layer", args: { comp: comp.id, name: "Underline", shapes: [{ type: "path", vertices: [[0, 0], [700, 0]], closed: false, fill: false, stroke: "#ff3b5c", strokeWidth: 6, trimPaths: { end: 0 } }], position: [190, 950], parent: "LT Controller" } },
    { tool: "create_text_layer", args: { comp: comp.id, name: "Name", text: "Mariana Costa", font: "Arial-BoldMT", fontSize: 64, color: "#111827", anchor: "baseline-left", position: [195, 870], parent: "LT Controller" } },
    { tool: "create_text_layer", args: { comp: comp.id, name: "Role", text: "Diretora de criação", fontSize: 36, color: "#4b5563", anchor: "baseline-left", position: [197, 920], parent: "LT Controller" } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Plate", preset: "scale-in", startTime: 0, duration: 0.5, easing: "expo" } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Accent", preset: "slide-in", direction: "left", startTime: 0.1, duration: 0.5, easing: "expo" } },
    { tool: "set_keyframes", args: { comp: comp.id, layer: "Underline", property: "Contents/Shape 1/Contents/Trim Paths 1/End", keyframes: [{ time: 0.4, value: 0 }, { time: 1.1, value: 100 }], easing: "ease-out" } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Name", preset: "text-fade-up", startTime: 0.35, duration: 0.7 } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Role", preset: "text-fade-up", startTime: 0.55, duration: 0.7 } },
    { tool: "set_layer_properties", args: { comp: comp.id, layers: ["Plate", "Accent", "Name", "Role"], motionBlur: true } },
  ] });
  if (b.r.isError) task.notes.push(b.text.slice(0, 300));
  const s = await sheet(comp.id, "a1-sheet.jpg");
  // checks the old bugs: text keeps its case and font, is left-aligned inside the plate, visible after the fade
  const props = (await call("get_properties_at_time", { comp: comp.id, time: 2, requests: [{ layer: "Name", properties: ["Source Text", "Opacity"] }, { layer: "Role", properties: ["Opacity"] }] })).data;
  end({ sheet: s, check: props?.results });
}

// ---------------------------------------------------------------- A2 kinetic 9:16
begin("A2", "Kinetic type 9:16, 6 words");
{
  const comp = (await call("create_composition", { name: "QA A2 Kinetic", preset: "vertical", duration: 4, backgroundColor: "#0f0f14", open: false })).data;
  const words = [["Cada", "pop"], ["ideia", "slide-in"], ["merece", "blur-in"], ["virar", "rotate-in"], ["movimento", "scale-in"], ["agora.", "typewriter"]];
  const ops = [];
  words.forEach(([w, preset], i) => {
    ops.push({ tool: "create_text_layer", args: { comp: comp.id, name: w, text: w, font: "Arial-BoldMT", fontSize: i === 4 ? 150 : 130, color: i === 5 ? "#ff3b5c" : "#ffffff", position: [540, 520 + i * 170] } });
    ops.push({ tool: "animate_layer", args: { comp: comp.id, layer: w, preset, startTime: 0.25 + i * 0.35, duration: 0.5, direction: "left" } });
  });
  const b = await call("batch", { operations: ops });
  if (b.r.isError) task.notes.push(b.text.slice(0, 300));
  const s = await sheet(comp.id, "a2-sheet.jpg");
  const txt = (await call("get_properties_at_time", { comp: comp.id, time: 3.5, requests: [{ layer: "agora.", properties: ["Source Text"] }] })).data;
  end({ sheet: s, check: txt?.results });
}

// ---------------------------------------------------------------- A3 logo reveal 3D
begin("A3", "3D logo reveal");
{
  const comp = (await call("create_composition", { name: "QA A3 Logo Reveal", preset: "1080p", duration: 5, backgroundColor: "#05060a", open: false })).data;
  const b = await call("batch", { operations: [
    { tool: "create_solid_layer", args: { comp: comp.id, name: "Floor", color: "#141824", threeD: true, position: [960, 760, 0], rotation: 0 } },
    { tool: "create_shape_layer", args: { comp: comp.id, name: "Hex", threeD: true, shapes: [{ type: "polygon", points: 6, size: [360, 360], gradient: { type: "linear", colors: [{ offset: 0, color: "#29d3ff" }, { offset: 1, color: "#7b3bff" }] } }], position: [960, 500] } },
    { tool: "create_shape_layer", args: { comp: comp.id, name: "Ring", threeD: true, shapes: [{ type: "ellipse", size: [460, 460], fill: false, stroke: "#29d3ff", strokeWidth: 8, trimPaths: { end: 0 } }], position: [960, 500] } },
    { tool: "create_text_layer", args: { comp: comp.id, name: "Brand", text: "Nova Labs", font: "Arial-BoldMT", fontSize: 110, color: "#ffffff", position: [960, 820], threeD: true } },
    { tool: "add_layer_style", args: { comp: comp.id, layer: "Hex", style: "outer-glow", params: { Size: 30, Opacity: 60 } } },
    { tool: "add_mask", args: { comp: comp.id, layer: "Brand", rect: [-400, -120, 0, 200], name: "Reveal", feather: 30 } },
    { tool: "modify_mask", args: { comp: comp.id, layer: "Brand", mask: "Reveal", keyframes: { property: "path", keys: [{ time: 1.2, value: { rect: [-400, -120, 0, 200] } }, { time: 2.2, value: { rect: [-400, -120, 800, 200] } }] } } },
    { tool: "set_keyframes", args: { comp: comp.id, layer: "Ring", property: "Contents/Shape 1/Contents/Trim Paths 1/End", keyframes: [{ time: 0.3, value: 0 }, { time: 1.4, value: 100 }], easing: "ease-in-out" } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Hex", preset: "pop", startTime: 0.6, duration: 0.6 } },
    { tool: "create_camera", args: { comp: comp.id, name: "Cam", zoom: 1500 } },
    { tool: "set_keyframes", args: { comp: comp.id, layer: "Cam", property: "Position", keyframes: [{ time: 0, value: [960, 540, -2200] }, { time: 4, value: [960, 540, -1500] }], easing: "ease-out" } },
    { tool: "create_light", args: { comp: comp.id, name: "Key", lightType: "spot", intensity: 120, coneAngle: 70, coneFeather: 60, castsShadows: true, position: [700, 200, -900], pointOfInterest: [960, 520, 0] } },
    { tool: "create_light", args: { comp: comp.id, name: "Fill", lightType: "ambient", intensity: 35 } },
  ] });
  if (b.r.isError) task.notes.push(b.text.slice(0, 300));
  const s = await sheet(comp.id, "a3-sheet.jpg");
  const cam = (await call("get_properties_at_time", { comp: comp.id, time: 0, requests: [{ layer: "Cam", properties: ["Point of Interest", "Position"] }] })).data;
  end({ sheet: s, check: cam?.results });
}

// ---------------------------------------------------------------- A4 Essential Graphics 3x
begin("A4", "Essential Graphics template used 3 times");
{
  const tpl = (await call("create_composition", { name: "QA A4 Badge", width: 900, height: 200, duration: 4, open: false })).data;
  const b = await call("batch", { operations: [
    { tool: "create_shape_layer", args: { comp: tpl.id, name: "Pill", shapes: [{ type: "rectangle", size: [860, 160], fill: "#ff3b5c", roundness: 80 }] } },
    { tool: "create_text_layer", args: { comp: tpl.id, name: "Label", text: "Ao vivo agora!", font: "Arial-BoldMT", fontSize: 72, color: "#ffffff" } },
    { tool: "add_to_essential_graphics", args: { comp: tpl.id, layer: "Label", property: "Source Text", name: "Texto", templateName: "QA Badge" } },
    { tool: "add_to_essential_graphics", args: { comp: tpl.id, layer: "Pill", property: "Contents/Shape 1/Contents/Fill 1/Color", name: "Cor" } },
  ] });
  if (b.r.isError) task.notes.push(b.text.slice(0, 300));
  const main = (await call("create_composition", { name: "QA A4 Main", preset: "1080p", duration: 4, backgroundColor: "#101318", open: false })).data;
  const inst = await call("instantiate_template", { template: tpl.id, into: main.id, items: [
    { name: "Badge 1", position: [960, 300], values: { Texto: "Ao vivo agora!", Cor: "#ff3b5c" } },
    { name: "Badge 2", position: [960, 540], values: { Texto: "Novo episódio 🎬", Cor: "#2f80ed" } },
    { name: "Badge 3", position: [960, 780], values: { Texto: "Inscreva-se", Cor: "#27ae60" } },
  ] });
  if (inst.r.isError) task.notes.push(inst.text.slice(0, 300));
  const s = await sheet(main.id, "a4-sheet.jpg", 4);
  end({ sheet: s, check: inst.data });
}

// ---------------------------------------------------------------- A5 import, look, render
begin("A5", "Import, look, render");
{
  const clip = path.join(WORK, "source.mp4");
  execFileSync(path.join(FFBIN, "ffmpeg.exe"), ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=3", "-pix_fmt", "yuv420p", clip]);
  const comp = (await call("create_composition", { name: "QA A5 Look", preset: "1080p", duration: 3, open: false })).data;
  const imp = await call("import_files", { paths: [clip], addToComp: comp.id });
  const b = await call("batch", { operations: [
    { tool: "set_layer_properties", args: { comp: comp.id, layer: 1, scale: 110, name: "Footage" } },
    { tool: "set_keyframes", args: { comp: comp.id, layer: "Footage", property: "Scale", keyframes: [{ time: 0, value: [110, 110] }, { time: 3, value: [100, 100] }], easing: "ease-out" } },
    { tool: "apply_effect_template", args: { comp: comp.id, layer: "Footage", template: "cinematic-look" } },
    { tool: "apply_effect_template", args: { comp: comp.id, layer: "Footage", template: "vignette-soft" } },
    { tool: "animate_layer", args: { comp: comp.id, layer: "Footage", preset: "blur-in", startTime: 0, duration: 0.6 } },
  ] });
  if (b.r.isError) task.notes.push(b.text.slice(0, 300));
  const s = await sheet(comp.id, "a5-sheet.jpg", 6);
  const out = path.join(WORK, "a5-render.mp4");
  const rnd = await call("render_in_background", { comp: comp.id, outputPath: out, preset: "mp4-h264-high", wait: true, overwrite: true });
  let probe = null;
  try { probe = execFileSync(path.join(FFBIN, "ffprobe.exe"), ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "csv=p=0", out], { encoding: "utf8" }).trim(); } catch (e) { probe = String(e.message).slice(0, 120); }
  end({ sheet: s, check: { imported: imp.data?.imported?.length, render: rnd.data?.status, seconds: rnd.data?.seconds, ffprobe: probe } });
}

fs.writeFileSync(path.join(OUT, "qa-after.json"), JSON.stringify({ date: new Date().toISOString(), server: st.server, listener: st.listener?.version, ae: st.compatibility?.aeVersion, tasks: report }, null, 2));
await call("save_project", { overwrite: true });
console.log("\nsaved", path.join(OUT, "qa-after.json"));
await c.close();
