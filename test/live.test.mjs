// Live end-to-end test against a running After Effects.
// Usage: node test/live.test.mjs [outDir] [--cleanup]
//   --cleanup removes everything the test created from the project at the end.
// Uses only a fresh comp named "MCP Test *"; it never touches other project content.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const CLEANUP = argv.includes("--cleanup");
const outArg = argv.find((a) => !a.startsWith("--"));
const out = path.resolve(outArg || fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-live-")));
const created = []; // project item ids this test created (removed with --cleanup)
fs.mkdirSync(out, { recursive: true });
const fwd = (p) => p.replace(/\\/g, "/");

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "build", "index.js")], env: { ...process.env }, stderr: "pipe" });
const client = new Client({ name: "live-test", version: "1.0.0" });
await client.connect(transport);

const results = [];
// Center pixel [r,g,b] of an image file (Windows: System.Drawing; elsewhere: skip with a neutral value).
function centerPixel(file) {
  if (process.platform !== "win32") return [255, 0, 0];
  const ps = `Add-Type -AssemblyName System.Drawing; $b=[System.Drawing.Bitmap]::FromFile('${file.replace(/'/g, "''")}'); $p=$b.GetPixel([int]($b.Width/2),[int]($b.Height/2)); "$($p.R),$($p.G),$($p.B)"; $b.Dispose()`;
  return execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim().split(",").map(Number);
}
async function call(name, args = {}, { expectError = false, check } = {}) {
  const t0 = Date.now();
  let r, pass, note = "";
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    pass = expectError ? !!r.isError : !r.isError;
    let data = null;
    if (!r.isError) { try { data = JSON.parse(text); } catch { data = text; } }
    if (pass && check) {
      const c = check(data, r);
      if (c !== true) { pass = false; note = `check failed: ${c}`; }
    }
    if (!pass && !note) note = text.slice(0, 300);
    results.push({ tool: name, pass, ms: Date.now() - t0, note });
    console.log(`${pass ? "PASS" : "FAIL"} ${name.padEnd(26)} ${String(Date.now() - t0).padStart(6)} ms  ${note}`);
    return { data, r };
  } catch (e) {
    results.push({ tool: name, pass: false, ms: Date.now() - t0, note: String(e.message) });
    console.log(`FAIL ${name} ${e.message}`);
    return { data: null };
  }
}

const COMP = `MCP Test ${Date.now() % 100000}`;
// solids that existed before the test: cleanup must never remove them
const solidsBefore = CLEANUP ? JSON.parse((await client.callTool({ name: "list_project_items", arguments: { type: "solid", limit: 1000 } })).content[0].text).items.map((i) => i.id) : [];
const foldersBefore = CLEANUP ? JSON.parse((await client.callTool({ name: "list_project_items", arguments: { type: "folder", limit: 1000 } })).content[0].text).items.map((i) => i.id) : [];
const st = await call("bridge_status", {}, { check: (d) => (d.ae?.ok ? true : JSON.stringify(d)) });
console.log("mode:", st.data?.mode, "AE", st.data?.ae?.aeVersion);

await call("get_project_info", {}, { check: (d) => (typeof d.compositionCount === "number" && d.counts && !("numLayers" in (d.compositions[0] ?? {})) ? true : JSON.stringify(d).slice(0, 200)) });
const comp = await call("create_composition", { name: COMP, preset: "1080p", duration: 6, frameRate: 30, backgroundColor: "#101820" }, { check: (d) => d.width === 1920 || "size" });
const C = comp.data?.id;
await call("get_project_info", { detail: true }, { check: (d) => (d.compositions.some((c) => c.id === C && typeof c.numLayers === "number") ? true : "detail missing comp") });
await call("create_solid_layer", { comp: C, name: "BG", color: "#1b2a41" });
await call("create_solid_layer", { comp: C, name: "Grade", adjustment: true });
await call("create_text_layer", { comp: C, text: "AFTER EFFECTS MCP", font: "Arial-BoldMT", fontSize: 120, color: "#ffffff", tracking: 40, name: "Title" }, { check: (d) => (d.type === "text" ? true : "type") });
await call("create_text_layer", { comp: C, text: "fonte inexistente", font: "NoSuchFont-XYZ", fontSize: 50, position: [960, 700], name: "Sub" }, { check: (d) => (d.warning ? true : "expected font warning") });
await call("create_shape_layer", { comp: C, name: "Shapes", position: [960, 860], shapes: [
  { type: "rectangle", size: [700, 8], roundness: 4, fill: "#ff3366", trimPaths: { start: 0, end: 100 } },
  { type: "ellipse", size: 60, fill: "#33ccff", offset: [-400, 0] },
  { type: "star", points: 5, outerRadius: 40, fill: "#ffcc00", stroke: "#ffffff", strokeWidth: 3, offset: [400, 0] },
] });
await call("create_shape_layer", { comp: C, type: "polygon", points: 6, size: 160, fill: "#7a5cff", position: [250, 250], rotation: 15, name: "Hex" }, { check: (d) => (Math.round(d.transform.rotation) === 15 ? true : "rotation applied twice? " + d.transform.rotation) });
await call("create_null_layer", { comp: C, name: "Controller", childLayers: ["Shapes"] });
await call("create_camera", { comp: C, name: "Cam", focalLength: 50 });
await call("create_light", { comp: C, name: "Key", lightType: "spot", color: "#fff4e0", intensity: 120 });
await call("list_layers", { comp: C }, { check: (d) => (d.count === 9 ? true : "count " + d.count) });
await call("create_text_layer", { comp: C, text: "x".repeat(100000), allowLargeText: true, fontSize: 10, name: "Huge" }, { check: (d) => (JSON.stringify(d).length < 2048 && d.textTruncated && d.textLength === 100000 ? true : "response " + JSON.stringify(d).length + " bytes") });
await call("list_layers", { comp: C, limit: 3, offset: 1 }, { check: (d) => (d.count === 3 && d.total === 10 && d.truncated && d.layers[0].index === 2 ? true : JSON.stringify({ c: d.count, t: d.total, tr: d.truncated })) });
await call("delete_layers", { comp: C, layers: ["Huge"] });

await call("set_keyframes", { comp: C, layer: "Title", property: "Scale", easing: "easy-ease", keyframes: [{ time: 0, value: [80, 80] }, { time: 1, value: [100, 100] }] }, { check: (d) => (d.numKeys === 2 ? true : "keys") });
await call("set_keyframes", { comp: C, layer: "Title", property: "Transform/Position", keyframes: [{ time: 0, value: [960, 600] }, { time: 1.2, value: [960, 520], easeIn: { influence: 90 }, easeOut: { influence: 10 } }] });
await call("animate_layer", { comp: C, layer: "Title", preset: "fade-in", duration: 0.8 });
await call("animate_layer", { comp: C, layer: "Sub", preset: "typewriter", startTime: 1, duration: 1.5 });
await call("animate_layer", { comp: C, layer: "Hex", preset: "pop", startTime: 0.5 });
await call("animate_layer", { comp: C, layer: "Hex", preset: "rotate-continuous", amount: 45 });
await call("animate_layer", { comp: C, layer: "Shapes", preset: "slide-in", direction: "left", startTime: 0.3 });
await call("animate_layer", { comp: C, layer: "Title", preset: "bounce", property: "Scale" });
await call("animate_layer", { comp: C, layer: "Sub", preset: "text-fade-up", startTime: 2.5 });
await call("set_expression", { comp: C, layer: "Controller", property: "Rotation", expression: "wiggle(1, 3)" }, { check: (d) => (!d.expressionError ? true : d.expressionError) });
await call("set_expression", { comp: C, layer: "Hex", property: "Opacity", expression: "thisIsNotDefined * 2" }, { check: (d) => (d.expressionError ? true : "expected expression error") });
await call("check_expressions", { comp: C }, { check: (d) => (d.errors.length === 1 ? true : JSON.stringify(d.errors)) });
await call("set_expression", { comp: C, layer: "Hex", property: "Opacity", expression: "" });

await call("apply_effect", { comp: C, layer: "Title", effect: "Gaussian Blur", params: { Blurriness: 4, "Repeat Edge Pixels": true } }, { check: (d) => (d.results[0].set.length === 2 ? true : JSON.stringify(d.results[0])) });
await call("apply_effect", { comp: C, layers: ["BG"], effect: "ADBE Fractal Noise", params: { Contrast: 120, Evolution: { expression: "time*60" } } });
await call("apply_effect", { comp: C, layer: "Title", effect: "Gausian Blurr" }, { expectError: true });
await call("apply_effect_template", { comp: C, layer: "Grade", template: "cinematic-look" });
await call("apply_effect_template", { comp: C, layer: "Title", template: "text-pop" });
await call("get_layer_effects", { comp: C, layer: "Title" }, { check: (d) => (d.effects.length >= 3 ? true : "effects " + d.effects.length) });
await call("modify_effect", { comp: C, layer: "Title", effect: "Gaussian Blur", params: { Blurriness: { keyframes: [{ time: 0, value: 30 }, { time: 0.8, value: 0 }] } } });
await call("get_property", { comp: C, layer: "Title", property: "Effects/Gaussian Blur/Blurriness" }, { check: (d) => (d.numKeys === 2 ? true : "numKeys " + d.numKeys) });
await call("get_property", { comp: C, layer: "Shapes", property: "Contents/1" }, { check: (d) => (d.children?.length ? true : "children") });
await call("set_property", { comp: C, layer: "Hex", property: "Contents/1/Contents/Fill 1/Color", value: "#00ff99" });
await call("get_property", { comp: C, layer: "Nope", property: "Position" }, { expectError: true });

await call("add_mask", { comp: C, layer: "BG", shape: "ellipse", rect: [160, 90, 1600, 900], feather: 300, mode: "add" });
await call("add_marker", { comp: C, time: 1, comment: "Title in", duration: 0.5 });
await call("add_marker", { comp: C, layer: "Title", time: 2, comment: "beat" });
await call("list_markers", { comp: C, includeLayers: true }, { check: (d) => (d.comp.length === 1 && d.layers.length === 1 ? true : JSON.stringify(d)) });
await call("set_text", { comp: C, layer: "Title", text: "AE MCP PRO", fillColor: "#ffe9a8" }, { check: (d) => (d.text.text === "AE MCP PRO" ? true : "text") });
await call("set_layer_properties", { comp: C, layers: ["Title", "Sub", "Hex"], motionBlur: true });
await call("set_composition_settings", { comp: C, motionBlur: true, currentTime: 2 });
const dup = await call("duplicate_layer", { comp: C, layer: "Hex", count: 3, newName: "Hex", offset: [200, 0], timeOffset: 0.2 }, { check: (d) => (d.duplicates.map((x) => x.name).join(",") === "Hex 1,Hex 2,Hex 3" ? true : JSON.stringify(d.duplicates.map((x) => x.name))) });
await call("sequence_layers", { comp: C, layers: ["Hex 1", "Hex 2", "Hex 3"], stagger: 0.25, startTime: 0.5 });
await call("align_layers", { comp: C, layers: ["Sub"], horizontal: "center", vertical: "bottom", margin: 80 });
await call("reorder_layer", { comp: C, layer: "BG", position: "bottom" });
await call("set_parent", { comp: C, layers: ["Hex 1"], parent: "Controller" });
const matte = await call("create_text_layer", { comp: C, text: "MATTE", fontSize: 300, name: "MatteText" });
await call("create_solid_layer", { comp: C, name: "Gradient fill", color: "#ff8800" });
await call("set_track_matte", { comp: C, layer: "Gradient fill", matteLayer: "MatteText", type: "alpha" }, { check: (d) => (d.trackMatte === "alpha" ? true : JSON.stringify(d.trackMatte)) });
await call("split_layer", { comp: C, layer: "Hex 3", time: 3 });
await call("run_extendscript", { code: "throw new Error('fail while parked')", parkViewer: true }, { expectError: true });
await call("run_extendscript", { code: "var n=0; for (var i=1;i<=app.project.numItems;i++) if (app.project.item(i).name==='__aemcp_parked__') n++; return n;" }, { check: (d) => (d.result === 0 ? true : `parked comp left behind: ${d.result}`) });
const pre = await call("precompose_layers", { comp: C, layers: ["MatteText", "Gradient fill"], name: "Matte Precomp" });
if (pre.data?.precomp?.id) created.push(pre.data.precomp.id);
await call("get_layer_details", { comp: C, layer: "Title", onlyAnimated: true }, { check: (d) => (d.properties.length ? true : "no animated props") });
await call("get_composition", { comp: C });
await call("get_selection");
await call("select_layers", { comp: C, layers: ["Title"] });
await call("get_selection", {}, { check: (d) => (d.layers.length === 1 && d.layers[0].name === "Title" ? true : JSON.stringify(d.layers.map((l) => l.name))) });

await call("list_fonts", { query: "arial", limit: 5 });
await call("list_available_effects", { query: "glow" }, { check: (d) => (d.count > 0 ? true : "none") });

const b = await call("batch", { operations: [
  { tool: "create_text_layer", args: { comp: C, text: "Batch 1", position: [300, 150], fontSize: 40, name: "B1" } },
  { tool: "create_text_layer", args: { comp: C, text: "Batch 2", position: [300, 200], fontSize: 40, name: "B2" } },
  { tool: "animate_layer", args: { comp: C, layer: "B1", preset: "slide-up-fade" } },
  { tool: "animate_layer", args: { comp: C, layer: "B2", preset: "scale-in" } },
] }, { check: (d) => (d.results.every((x) => x.ok) ? true : JSON.stringify(d.results)) });
const before = (await call("list_layers", { comp: C })).data?.count;
await call("undo", {}, {});
await call("list_layers", { comp: C }, { check: (d) => (d.count === before - 2 ? true : `undo did not revert batch as one step: ${before} -> ${d.count}`) });
await call("undo", { action: "redo" });

// progress: a 100-operation batch with a progressToken streams increasing notifications
{
  const seen = [];
  const ops = Array.from({ length: 100 }, (_, i) => ({ tool: "create_null_layer", args: { comp: C, name: `PG${i}` } }));
  const t0 = Date.now();
  const r = await client.callTool({ name: "batch", arguments: { operations: ops } }, undefined, { timeout: 600_000, onprogress: (p) => seen.push(p.progress) });
  const increasing = seen.every((v, i) => i === 0 || v > seen[i - 1]);
  results.push({ tool: "progress", pass: !r.isError && seen.length >= 5 && increasing, ms: Date.now() - t0, note: `${seen.length} notifications` });
  console.log(`${seen.length >= 5 && increasing ? "PASS" : "FAIL"} progress notifications: ${seen.length}`);
  await call("delete_layers", { comp: C, layers: ops.map((o) => o.args.name), removeSources: true });
}
const nBefore = (await call("list_layers", { comp: C })).data?.total;
await call("batch", { operations: [
  { tool: "create_null_layer", args: { comp: C, name: "BP1" } },
  { tool: "set_property", args: { comp: C, layer: "No Such Layer", property: "Opacity", value: 50 } },
  { tool: "create_null_layer", args: { comp: C, name: "BP2" } },
] }, { expectError: true });
await call("list_layers", { comp: C, query: "BP" }, { check: (d) => (d.total === 1 && d.layers[0].name === "BP1" ? true : "partial batch state " + JSON.stringify(d.layers.map((l) => l.name))) });
await call("delete_layers", { comp: C, layers: ["BP1"] });
await call("batch", { atomic: true, operations: [
  { tool: "create_null_layer", args: { comp: C, name: "AT1" } },
  { tool: "set_property", args: { comp: C, layer: "No Such Layer", property: "Opacity", value: 50 } },
] }, { expectError: true });
await call("list_layers", { comp: C }, { check: (d) => (d.total === nBefore ? true : `atomic batch not reverted: ${nBefore} -> ${d.total}`) });
await call("create_null_layer", { comp: C, name: "TmpNull" });
await call("delete_layers", { comp: C, layers: ["TmpNull"], removeSources: true }, { check: (d) => (d.removedSources === 1 ? true : JSON.stringify(d)) });
// undo group: 3 calls, one undo, all 3 layers gone
{
  const before = (await call("list_layers", { comp: C })).data?.total;
  await call("begin_undo_group", { name: "three nulls" });
  for (let i = 0; i < 3; i++) await call("create_null_layer", { comp: C, name: `UG${i}` });
  await call("end_undo_group", {}, { check: (d) => (d.steps === 3 ? true : JSON.stringify(d)) });
  await call("undo", {}, { check: (d) => (/3 step/.test(d.note) ? true : JSON.stringify(d)) });
  await call("list_layers", { comp: C }, { check: (d) => (d.total === before ? true : `expected ${before} layers, got ${d.total}`) });
}
await call("delete_layers", { comp: C, layers: ["Grade"] });
await call("remove_keyframes", { comp: C, layer: "Title", property: "Position", from: 1 });
await call("remove_masks", { comp: C, layer: "BG" });
await call("remove_markers", { comp: C, comment: "Title in" });

await call("run_extendscript", { code: "var c = AEMCP.getComp(args.c); return { layers: c.numLayers, name: c.name };", args: { c: C } }, { check: (d) => (d.result.name === COMP ? true : JSON.stringify(d)) });
await call("run_extendscript", { code: "throw new Error('boom')" }, { expectError: true });
// timeoutSeconds: AE keeps running the 8 s loop after the client gives up; the next call must still work
{
  const t0 = Date.now();
  const r = await call("run_extendscript", { code: "var t = new Date().getTime(); while (new Date().getTime() - t < 8000) {} return 1;", timeoutSeconds: 3 }, { expectError: true });
  const txt = r.r?.content?.[0]?.text ?? "";
  results.push({ tool: "timeout_hint", pass: Date.now() - t0 < 6000 && /still be running|still running/.test(txt) && /timeoutSeconds/.test(txt), ms: Date.now() - t0, note: txt.slice(0, 200) });
  await call("get_project_info", { timeoutSeconds: 30 }, { check: () => true });
}

const frame = await call("preview_frame", { comp: C, time: 2.5, maxSize: 960, savePath: path.join(out, "frame.png") }, { check: (d, r) => (r.content.some((c) => c.type === "image" && c.data.length > 1000) && d.previewWidth === 960 ? true : "no image / not resized " + JSON.stringify(d)) });
await call("preview_contact_sheet", { comp: C, frames: 4, maxSize: 400 }, {
  check: (_d, r) => {
    const imgs = r.content.filter((c) => c.type === "image");
    imgs.forEach((im, i) => fs.writeFileSync(path.join(out, `sheet-${i}.jpg`), Buffer.from(im.data, "base64")));
    return imgs.length === 1 && imgs[0].mimeType === "image/jpeg" ? true : "images " + imgs.length;
  },
});
{
  const t0 = Date.now();
  await call("preview_contact_sheet", { comp: C, frames: 12 }, {
    check: (_d, r) => {
      const bytes = r.content.filter((c) => c.type === "image").reduce((n, c) => n + c.data.length * 0.75, 0);
      fs.writeFileSync(path.join(out, "sheet-12.jpg"), Buffer.from(r.content.find((c) => c.type === "image").data, "base64"));
      return Date.now() - t0 < 4000 && bytes < 200_000 ? true : `12 frames took ${Date.now() - t0} ms, ${Math.round(bytes / 1024)} KB`;
    },
  });
}
// background: an empty red comp must preview red, not dark gray
{
  const red = await call("create_composition", { name: COMP + " red", width: 320, height: 180, duration: 1, backgroundColor: "#ff0000", open: false });
  for (const fmt of ["jpeg", "png"]) {
    await call("preview_frame", { comp: red.data?.id, time: 0, format: fmt, savePath: undefined }, {
      check: (_d, r) => {
        const img = r.content.find((c) => c.type === "image");
        const file = path.join(out, `red.${fmt === "png" ? "png" : "jpg"}`);
        fs.writeFileSync(file, Buffer.from(img.data, "base64"));
        const px = centerPixel(file);
        return px[0] > 200 && px[1] < 60 && px[2] < 60 ? true : `center pixel ${px}`;
      },
    });
  }
  await call("modify_item", { item: red.data?.id, delete: true });
}
const folder = await call("create_folder", { name: "MCP Test Assets" });
const imp = await call("import_files", { paths: [path.join(out, "frame.png")], folder: "MCP Test Assets", addToComp: C }, { check: (d) => (d.imported.length === 1 && d.imported[0].layer ? true : JSON.stringify(d)) });
for (const it of imp.data?.imported ?? []) created.push(it.id);
if (folder.data?.id) created.push(folder.data.id);
const items = await call("list_project_items", { type: "still" });
await call("add_item_to_comp", { comp: C, item: items.data?.items?.[0]?.id, fitToComp: "fit", opacity: 20, name: "Ref" });
// new tools (item 13)
{
  // replace_footage: swap the imported frame for the red preview, comps keep using it
  const fr = (await call("list_project_items", { type: "still", query: "frame" })).data?.items?.[0];
  if (fr) await call("replace_footage", { item: fr.id, file: path.join(out, "red.png") }, { check: (d) => (/red\.png$/i.test(d.file) && d.usedInComps >= 1 ? true : JSON.stringify(d)) });
  await call("list_presets", { query: "fade", limit: 5 }, { check: (d) => (d.roots.length >= 1 && d.total >= 1 && d.presets[0].path.endsWith(".ffx") ? true : JSON.stringify(d).slice(0, 200)) });
  await call("get_properties_at_time", { comp: C, time: 1, requests: [{ layer: "Title", properties: ["Opacity", "Scale", "Effects/Gaussian Blur/Blurriness", "No/Such"] }, { layer: "Nope", properties: ["Opacity"] }] }, {
    check: (d) => (typeof d.results[0].values.Opacity === "number" && d.results[0].values["No/Such"].error && d.results[1].error ? true : JSON.stringify(d).slice(0, 300)),
  });
  // Essential Graphics: expose a property in a template comp, override it on one instance
  const tpl = await call("create_composition", { name: COMP + " tpl", width: 400, height: 200, duration: 2, open: false });
  created.push(tpl.data?.id);
  await call("create_text_layer", { comp: tpl.data?.id, text: "Template", name: "T" });
  await call("add_to_essential_graphics", { comp: tpl.data?.id, layer: "T", property: "Opacity", name: "Title Opacity" }, { check: (d) => (d.controllers.includes("Title Opacity") ? true : JSON.stringify(d)) });
  await call("list_essential_properties", { comp: tpl.data?.id }, { check: (d) => (d.controllers.length === 1 ? true : JSON.stringify(d)) });
  const inst = await call("add_item_to_comp", { comp: C, item: tpl.data?.id, name: "TplInstance" });
  await call("set_essential_property", { comp: C, layer: "TplInstance", property: "Title Opacity", value: 25 }, { check: (d) => (d.value === 25 ? true : JSON.stringify(d)) });
  await call("list_essential_properties", { comp: C, layer: "TplInstance" }, { check: (d) => (d.properties[0].value === 25 ? true : JSON.stringify(d)) });
}

await call("duplicate_composition", { comp: C, newName: COMP + " copy" });
await call("organize_items", { items: [COMP + " copy"], folder: "MCP Test Assets" });
await call("modify_item", { item: COMP + " copy", delete: true });
await call("list_compositions");

await call("add_to_render_queue", { comp: C, outputPath: path.join(out, "queue-render.mov"), format: "lossless", start: 0, duration: 0.5 }, { check: (d) => (d.added.outputFile ? true : "no output") });
await call("get_render_queue", {}, { check: (d) => (d.items.length >= 1 ? true : "empty") });
await call("clear_render_queue");

await call("save_project", { path: path.join(out, "mcp-live-test.aep"), overwrite: true }, { check: (d) => (d.saved ? true : "not saved") });
const job = await call("render_in_background", { comp: COMP, outputPath: path.join(out, "bg-render.avi"), startFrame: 0, endFrame: 14 });
if (job.data?.jobId) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await client.callTool({ name: "get_background_render", arguments: { jobId: job.data.jobId } });
    const j = JSON.parse(s.content[0].text).jobs[0];
    if (j.status !== "running") {
      const okFile = (j.outputFiles || []).some((f) => fs.existsSync(f) && fs.statSync(f).size > 1000);
      results.push({ tool: "get_background_render", pass: j.status === "done" && okFile, ms: j.seconds * 1000, note: j.status === "done" ? "" : j.logTail.join(" | ").slice(-400) });
      console.log(`${j.status === "done" && okFile ? "PASS" : "FAIL"} background render finished: ${j.status} in ${j.seconds}s, file=${okFile}`);
      break;
    }
  }
}

// aerender with wait:true streams per-frame progress
if (job.data?.jobId) {
  const seen = [];
  const t0 = Date.now();
  const r = await client.callTool({ name: "render_in_background", arguments: { comp: COMP, outputPath: path.join(out, "bg-wait.avi"), startFrame: 0, endFrame: 9, wait: true } }, undefined, { timeout: 600_000, onprogress: (p) => seen.push(p.progress) });
  const d = r.isError ? {} : JSON.parse(r.content[0].text);
  results.push({ tool: "render_in_background(wait)", pass: d.status === "done" && seen.length >= 1, ms: Date.now() - t0, note: `${seen.length} progress, status ${d.status}` });
  console.log(`${d.status === "done" && seen.length >= 1 ? "PASS" : "FAIL"} render_in_background wait: ${seen.length} progress notifications`);
}

// structuredContent of the read tools must validate against their own output schemas
{
  const { OUTPUTS } = await import(new URL("../build/tools.js", import.meta.url).href);
  const cases = [["list_layers", { comp: C }], ["list_compositions", {}], ["get_composition", { comp: C }], ["get_layer_details", { comp: C, layer: 1 }], ["get_project_info", {}], ["bridge_status", {}], ["get_render_queue", {}], ["list_project_items", {}]];
  for (const [tool, args] of cases) {
    const r = await client.callTool({ name: tool, arguments: args });
    const v = OUTPUTS[tool].safeParse(r.structuredContent);
    results.push({ tool: "structured:" + tool, pass: !r.isError && v.success, ms: 0, note: v.success ? "" : JSON.stringify(v.error.issues).slice(0, 200) });
    console.log(`${v.success ? "PASS" : "FAIL"} structuredContent ${tool}`);
  }
}

if (CLEANUP) {
  // comp first (it uses the precomp and footage), then the rest; folder last
  for (const id of [C, ...created]) {
    if (!id) continue;
    await client.callTool({ name: "modify_item", arguments: { item: id, delete: true } }).catch(() => undefined);
  }
  // the test's nulls/solids left their sources in the Solids folder
  await call("remove_unused_footage", { type: "solid", keep: [...solidsBefore, ...foldersBefore] }, { check: (d) => (d.removed > 0 ? true : "nothing removed") });
  const solidsAfter = JSON.parse((await client.callTool({ name: "list_project_items", arguments: { type: "solid", limit: 1000 } })).content[0].text).items;
  const leftover = solidsAfter.filter((i) => !solidsBefore.includes(i.id));
  results.push({ tool: "cleanup_solids", pass: leftover.length === 0, ms: 0, note: leftover.length ? `${leftover.length} solids left` : "" });
  const left = await client.callTool({ name: "list_project_items", arguments: { query: "MCP Test" } });
  const items = JSON.parse(left.content[0].text).items.filter((i) => i.name === COMP || i.name === "MCP Test Assets");
  results.push({ tool: "cleanup", pass: items.length === 0, ms: 0, note: items.length ? JSON.stringify(items) : "" });
  console.log(`${items.length ? "FAIL" : "PASS"} cleanup removed ${created.length + 1} items`);
}

const passed = results.filter((r) => r.pass).length;
const tools = new Set(results.map((r) => r.tool));
console.log(`\n${passed}/${results.length} checks passed, ${tools.size} distinct tools exercised. Output: ${out}`);
fs.writeFileSync(path.join(out, "live-results.json"), JSON.stringify({ comp: COMP, results }, null, 1));
await client.close();
process.exit(passed === results.length ? 0 : 1);
