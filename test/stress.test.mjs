// Stress test against a running After Effects. Usage: npm run test:stress
// Uses one comp named "MCP Stress <n>" and removes it at the end.
// Prints median / p95 latency and response size for each scenario.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "stress", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "build", "index.js")], stderr: "pipe" }));

const rows = [];
let failures = 0;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
};
async function call(name, args, { expectError = false, timeout = 600_000 } = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const ms = Date.now() - t0;
  const bytes = JSON.stringify(res.content).length;
  const body = res.content.find((c) => c.type === "text")?.text ?? "";
  if (!!res.isError !== expectError) {
    failures++;
    console.log(`  UNEXPECTED ${res.isError ? "error" : "success"} in ${name}: ${body.slice(0, 200)}`);
  }
  return { ms, bytes, res, text: body };
}
async function scenario(label, fn) {
  const t0 = Date.now();
  const out = await fn();
  const line = { scenario: label, totalMs: Date.now() - t0, ...out };
  rows.push(line);
  console.log(JSON.stringify(line));
}

const COMP = `MCP Stress ${Date.now() % 100000}`;
const comp = JSON.parse((await call("create_composition", { name: COMP, preset: "1080p", duration: 10, open: false })).text);
const C = comp.id;

await scenario("latency x30 (get_composition)", async () => {
  const ms = [], bytes = [];
  for (let i = 0; i < 30; i++) { const r = await call("get_composition", { comp: C }); ms.push(r.ms); bytes.push(r.bytes); }
  return { ...stats(ms), bytesPerCall: stats(bytes).median };
});

await scenario("20 calls in parallel", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call("create_null_layer", { comp: C, name: `P${i}` })));
  const names = new Set(rs.map((r) => JSON.parse(r.text).name));
  if (names.size !== 20) { failures++; console.log("  parallel calls lost results"); }
  return stats(rs.map((r) => r.ms));
});

// Line separator, backslash, CR and LF built from char codes so no editor or shell can mangle them.
const LS = String.fromCharCode(0x2028), BS = String.fromCharCode(92), NL = String.fromCharCode(10), CR = String.fromCharCode(13);
await scenario("unicode text round trip", async () => {
  const text = "Olá 👋 東京 \"aspas\" 'simples' " + BS + " barra " + LS + " fim";
  const r = await call("create_text_layer", { comp: C, text, name: "Unicode" });
  const back = JSON.parse((await call("get_property", { comp: C, layer: "Unicode", property: "Source Text" })).text).value.text;
  // AE stores line breaks as CR; a line separator may come back as a line break
  const norm = (t) => t.split(CR).join(NL).split(LS).join(NL);
  if (norm(back) !== norm(text)) { failures++; console.log("  unicode mismatch:", JSON.stringify(back)); }
  return { ms: r.ms };
});

await scenario("100k-char text layer", async () => {
  const r = await call("create_text_layer", { comp: C, text: "x".repeat(100_000), allowLargeText: true, fontSize: 8, name: "Huge" });
  if (r.bytes > 2048) { failures++; console.log(`  response too big: ${r.bytes} bytes`); }
  await call("delete_layers", { comp: C, layers: ["Huge"] });
  return { ms: r.ms, bytes: r.bytes };
});

for (const n of [20, 50, 100]) {
  await scenario(`batch of ${n} shapes`, async () => {
    const ops = Array.from({ length: n }, (_, i) => ({ tool: "create_shape_layer", args: { comp: C, type: "ellipse", size: 30, position: [40 + (i % 40) * 45, 40 + Math.floor(i / 40) * 45], name: `S${n}_${i}` } }));
    const r = await call("batch", { operations: ops });
    return { ms: r.ms, msPerOp: Math.round(r.ms / n), bytes: r.bytes };
  });
}

await scenario("errors", async () => {
  const cases = [
    ["get_composition", { comp: "No Such Comp" }],
    ["get_layer_details", { comp: C, layer: "No Such Layer" }],
    ["get_property", { comp: C, layer: "P0", property: "No/Such/Prop" }],
    ["list_layers", { comp: C, notAnArgument: 1 }],
  ];
  const ms = [];
  for (const [tool, args] of cases) ms.push((await call(tool, args, { expectError: true })).ms);
  return stats(ms);
});

await scenario("batch with partial failure", async () => {
  const r = await call("batch", { operations: [{ tool: "create_null_layer", args: { comp: C, name: "BP1" } }, { tool: "set_property", args: { comp: C, layer: "Nope", property: "Opacity", value: 1 } }, { tool: "create_null_layer", args: { comp: C, name: "BP2" } }] }, { expectError: true });
  return { ms: r.ms, reportedFailed: /"failed":1/.test(r.text) };
});

await scenario("AE busy 20 s, then a queued call", async () => {
  const busy = call("run_extendscript", { code: "var t=new Date().getTime(); while(new Date().getTime()-t<20000){} return 1;", timeoutSeconds: 60 });
  await new Promise((r) => setTimeout(r, 500));
  const queued = call("get_project_info", { timeoutSeconds: 60 });
  const [b, q] = await Promise.all([busy, queued]);
  return { busyMs: b.ms, queuedMs: q.ms };
});

await scenario("timeoutSeconds honoured", async () => {
  const r = await call("run_extendscript", { code: "var t=new Date().getTime(); while(new Date().getTime()-t<8000){} return 1;", timeoutSeconds: 3 }, { expectError: true });
  if (r.ms > 6000) { failures++; console.log(`  timeout took ${r.ms} ms`); }
  await new Promise((res) => setTimeout(res, 7000)); // let AE finish the loop
  const after = await call("get_project_info", {});
  return { timeoutMs: r.ms, nextCallMs: after.ms };
});

await scenario("batch error in a 1000-layer comp", async () => {
  const big = JSON.parse((await call("run_extendscript", { code: "var c=app.project.items.addComp('MCP Stress Big',640,360,1,5,30); for (var i=0;i<1000;i++) c.layers.addNull(); return c.id;", timeoutSeconds: 600 })).text).result;
  const r = await call("batch", { operations: [{ tool: "set_property", args: { comp: big, layer: "No Such Layer", property: "Opacity", value: 1 } }] }, { expectError: true });
  if (r.text.length > 1500) { failures++; console.log(`  batch error is ${r.text.length} chars`); }
  await call("modify_item", { item: big, delete: true });
  return { ms: r.ms, errorChars: r.text.length };
});

await scenario("run_extendscript 200 shapes, comp open: parkViewer off vs on", async () => {
  const out = {};
  for (const park of [false, true]) {
    const comp = JSON.parse((await call("create_composition", { name: `MCP Stress Park ${park}`, preset: "1080p", open: true })).text);
    const r = await call("run_extendscript", { code: "var c=AEMCP.getComp(args.c); for (var i=0;i<200;i++){ var l=c.layers.addShape(); var g=l.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group'); g.property('ADBE Vectors Group').addProperty('ADBE Vector Shape - Ellipse'); } return c.numLayers;", args: { c: comp.id }, parkViewer: park, timeoutSeconds: 600 });
    out[park ? "parkedMs" : "openMs"] = r.ms;
    await call("modify_item", { item: comp.id, delete: true });
  }
  out.speedup = +(out.openMs / out.parkedMs).toFixed(2);
  return out;
});

await scenario("get_project_info with ~50 comps", async () => {
  const made = JSON.parse((await call("run_extendscript", { code: "var ids=[]; for (var i=0;i<50;i++) ids.push(app.project.items.addComp('MCP Stress PI '+i,640,360,1,5,30).id); return ids;" })).text).result;
  const ms = [];
  for (let i = 0; i < 5; i++) ms.push((await call("get_project_info", {})).ms);
  await call("run_extendscript", { code: "for (var i=0;i<args.ids.length;i++) AEMCP.findItem(args.ids[i]).remove(); return 1;", args: { ids: made } });
  const st = stats(ms);
  if (st.median > 500) { failures++; console.log(`  get_project_info median ${st.median} ms`); }
  return st;
});

await call("modify_item", { item: C, delete: true });
const status = JSON.parse((await call("bridge_status", {})).text);
console.log("\nbridge diagnostics:", JSON.stringify(status.diagnostics));
console.log(`\n${rows.length} scenarios, ${failures} unexpected result(s)`);
await client.close();
process.exit(failures ? 1 : 0);
