// Unit tests: no After Effects needed. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBridge = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-unit-"));

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "build", "index.js")],
    // AE_MCP_AE_PATH points nowhere so tests never touch a real After Effects
    env: { ...process.env, AE_MCP_BRIDGE_DIR: tmpBridge, AE_MCP_MODE: "listener", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "unit", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("runtime.jsx is valid ES3-compatible syntax", () => {
  const src = fs.readFileSync(path.join(root, "src", "jsx", "runtime.jsx"), "utf8");
  assert.doesNotThrow(() => new Function(src));
  // ExtendScript has no let/const/arrow functions/template literals
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(let|const)\s/.test(code), "no let/const");
  assert.ok(!/=>/.test(code), "no arrow functions");
  assert.ok(!/`/.test(code), "no template literals");
  assert.ok(!/\.indexOf\(\s*[a-z]+\s*\)\s*[<>]=?\s*0\s*\)\s*\{?\s*\/\/array/.test(code));
});

test("bridge listener and panel compile", () => {
  for (const f of ["ae-mcp-pro-listener.jsx", "AE MCP Pro.jsx"]) {
    const src = fs.readFileSync(path.join(root, "bridge", f), "utf8");
    assert.doesNotThrow(() => new Function(src), f);
  }
});

test("every AE-side tool has a runtime handler", async () => {
  const { TOOLS } = await import(path.join(root, "build", "tools.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  const src = fs.readFileSync(path.join(root, "src", "jsx", "runtime.jsx"), "utf8");
  for (const t of TOOLS) {
    if (t.handler === null) continue;
    const h = t.handler ?? t.name;
    assert.ok(new RegExp(`H\\.${h}\\s*=\\s*function`).test(src), `missing runtime handler H.${h}`);
  }
});

test("server lists tools with schemas, annotations and the After Effects icon", async () => {
  const client = await connect();
  const info = client.getServerVersion();
  assert.equal(info.name, "after-effects");
  assert.equal(info.title, "After Effects");
  assert.ok(Array.isArray(info.icons) && info.icons.length >= 1, "server icons");
  assert.match(info.icons[0].src, /^data:image\/(png|svg\+xml);base64,/);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 60, `expected 60+ tools, got ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  for (const n of ["create_composition", "set_keyframes", "preview_frame", "batch", "render_in_background", "animate_layer"]) assert.ok(names.has(n), n);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === "boolean", t.name);
    assert.ok(t.icons?.length, `${t.name} icon`);
  }
  await client.close();
});

test("invalid arguments are rejected before reaching After Effects", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "create_composition", arguments: { name: 5, width: -1 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments/);
  const r2 = await client.callTool({ name: "set_keyframes", arguments: { layer: 1, property: "Opacity", keyframes: [] } });
  assert.equal(r2.isError, true);
  const r3 = await client.callTool({ name: "batch", arguments: { operations: [{ tool: "preview_frame" }] } });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /cannot run inside batch/);
  const r4 = await client.callTool({ name: "batch", arguments: { operations: [{ tool: "create_composition", args: { width: 10 } }] } });
  assert.equal(r4.isError, true, "batch validates nested args");
  await client.close();
});

test("listener mode times out cleanly when AE is not answering", async () => {
  // fake a fresh heartbeat so the server queues the command, but nothing consumes it
  fs.writeFileSync(path.join(tmpBridge, "heartbeat.json"), JSON.stringify({ time: Date.now(), version: "x", ae: "x", paused: false, executed: 0, project: "" }));
  const client = await connect();
  const t0 = Date.now();
  const r = await client.callTool({ name: "get_project_info", arguments: { timeoutSeconds: 3 } });
  assert.equal(r.isError, true);
  assert.ok(Date.now() - t0 < 10_000, "timeoutSeconds respected");
  // works whether or not a real After Effects happens to be open on this machine
  assert.match(r.content[0].text, /never started this command|was closed/);
  // queue must be cleaned so a stale command never runs later
  const left = fs.readdirSync(path.join(tmpBridge, "queue"));
  assert.equal(left.length, 0, `queue not cleaned: ${left}`);
  await client.close();
});

test("paused bridge gives an actionable error", async () => {
  fs.writeFileSync(path.join(tmpBridge, "heartbeat.json"), JSON.stringify({ time: Date.now(), version: "x", ae: "x", paused: true, executed: 0, project: "" }));
  const client = await connect({ AE_MCP_MODE: "" });
  const r = await client.callTool({ name: "list_compositions", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /paused/i);
  await client.close();
});

test("command script escapes payloads safely", async () => {
  const { jsString } = await import(path.join(root, "build", "bridge.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  const nasty = 'a"b\\c\n </script>' + "'";
  const lit = jsString(nasty);
  assert.equal(new Function(`return ${lit};`)(), nasty);
});

test("prompts and resources are exposed", async () => {
  const client = await connect();
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.find((p) => p.name === "lower-third"));
  const p = await client.getPrompt({ name: "kinetic-title", arguments: { text: "Hello" } });
  assert.match(p.messages[0].content.text, /Hello/);
  const { resources } = await client.listResources();
  assert.ok(resources.find((r) => r.uri === "aftereffects://project"));
  await client.close();
});

// Fake listener: consumes queue files like AE would and writes results itself.
function fakeListener(dir, respond, version = "2.0.1") {
  const q = path.join(dir, "queue");
  let n = 0;
  const timer = setInterval(() => {
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ time: Date.now(), version, ae: "fake", paused: false, executed: n, project: "" }));
    for (const f of fs.existsSync(q) ? fs.readdirSync(q) : []) {
      if (!f.endsWith(".jsx")) continue;
      const src = fs.readFileSync(path.join(q, f), "utf8");
      fs.rmSync(path.join(q, f));
      // a queue file can hold several calls (coalescing): answer each one
      for (const m of src.matchAll(/\.run\((".*"), ("[^"]+\.json")\);/g)) {
        const payload = JSON.parse(JSON.parse(m[1]));
        const resultPath = JSON.parse(m[2]);
        fs.writeFileSync(resultPath, JSON.stringify(respond(payload, n++)));
      }
    }
  }, 20);
  return () => clearInterval(timer);
}

test("listener I/O errors are retried once automatically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-io-"));
  const stop = fakeListener(dir, (p, n) => (n === 0 ? { ok: false, id: p.id, error: "Script error: IOError: I/O error" } : { ok: true, id: p.id, data: { comps: 0, attempt: n } }));
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const r = await client.callTool({ name: "list_compositions", arguments: {} });
  stop();
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).attempt, 1);
  await client.close();
});

test("every tool opens the After Effects activity card (MCP Apps)", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) assert.equal(t._meta?.ui?.resourceUri, "ui://after-effects/activity.html", t.name);
  const { resources } = await client.listResources();
  const card = resources.find((r) => r.uri === "ui://after-effects/activity.html");
  assert.equal(card?.mimeType, "text/html;profile=mcp-app");
  const res = await client.readResource({ uri: card.uri });
  const html = res.contents[0].text;
  assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(html, /ui\/initialize/);
  assert.match(html, /After Effects/);
  assert.match(html, /src="data:image\/(png|svg\+xml);base64,/, "card shows the Ae icon");
  // the card script must at least parse
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  await client.close();
});

test("an outdated listener is reported on the first call and in bridge_status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-ver-"));
  const stop = fakeListener(dir, (p) => ({ ok: true, id: p.id, data: { ok: true } }), "1.0.0");
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const r1 = await client.callTool({ name: "list_compositions", arguments: {} });
  assert.match(r1.content.at(-1).text, /listener is version 1\.0\.0.*install-ae/);
  const r2 = await client.callTool({ name: "list_compositions", arguments: {} });
  assert.equal(r2.content.length, 1, "warning only once");
  const st = JSON.parse((await client.callTool({ name: "bridge_status", arguments: {} })).content[0].text);
  stop();
  assert.match(st.warning, /install-ae/);
  assert.ok(st.diagnostics.calls >= 2 && st.diagnostics.latencyMs.p95 !== null);
  await client.close();
});

test("cancelling a queued call removes it before After Effects runs it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-cancel-"));
  // heartbeat only: the fake AE never consumes the queue
  const beat = setInterval(() => fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ time: Date.now(), version: "2.0.1", ae: "fake", paused: false, executed: 0, project: "" })), 50);
  await new Promise((r) => setTimeout(r, 80));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const ac = new AbortController();
  const pending = client.callTool({ name: "list_compositions", arguments: {} }, undefined, { signal: ac.signal }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readdirSync(path.join(dir, "queue")).filter((f) => f.endsWith(".jsx")).length, 1, "command queued");
  ac.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(beat);
  assert.equal(fs.readdirSync(path.join(dir, "queue")).length, 0, "queue emptied after cancel");
  await client.close();
});

test("a failed batch shows the hint once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-hint-"));
  const hint = "Layers: 1:A, 2:B ... and 990 more";
  const stop = fakeListener(dir, (p) => ({ ok: true, id: p.id, data: { ok: false, failed: 1, stoppedAt: 0, executed: 1, total: 1, results: [{ index: 0, tool: "set_property", ok: false, error: "Layer 'X' not found" }], hint } }));
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const r = await client.callTool({ name: "batch", arguments: { operations: [{ tool: "set_property", args: { layer: "X", property: "Opacity", value: 1 } }] } });
  stop();
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text.split("990 more").length - 1, 1, "hint appears exactly once");
  await client.close();
});

test("texts over 20,000 characters are refused before reaching After Effects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-big-"));
  let reached = 0;
  const stop = fakeListener(dir, (p) => { reached++; return { ok: true, id: p.id, data: { name: "t" } }; });
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const huge = "x".repeat(20_001);
  const r1 = await client.callTool({ name: "create_text_layer", arguments: { text: huge } });
  const r2 = await client.callTool({ name: "set_text", arguments: { layer: 1, text: huge } });
  const r3 = await client.callTool({ name: "batch", arguments: { operations: [{ tool: "create_text_layer", args: { text: huge } }] } });
  assert.ok(r1.isError && r2.isError && r3.isError);
  assert.match(r1.content[0].text, /allowLargeText/);
  assert.equal(reached, 0, "nothing was sent to AE");
  const ok = await client.callTool({ name: "create_text_layer", arguments: { text: huge, allowLargeText: true } });
  stop();
  assert.ok(!ok.isError);
  assert.equal(reached, 1);
  await client.close();
});

test("read tools declare outputSchema and return matching structuredContent", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const want = ["list_layers", "list_compositions", "get_composition", "get_layer_details", "get_project_info", "bridge_status", "get_render_queue", "list_project_items"];
  for (const n of want) {
    const t = tools.find((x) => x.name === n);
    assert.equal(t.outputSchema?.type, "object", `${n} outputSchema`);
  }
  // bridge_status runs without AE: its structuredContent must match the schema
  const r = await client.callTool({ name: "bridge_status", arguments: {} });
  assert.equal(typeof r.structuredContent?.server, "string");
  const { OUTPUTS } = await import(path.join(root, "build", "tools.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
  assert.ok(OUTPUTS.bridge_status.safeParse(r.structuredContent).success);
  await client.close();
});

test("parallel calls share one queue file and each gets its own answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-coalesce-"));
  const files = [];
  const q = path.join(dir, "queue");
  const watcher = setInterval(() => { for (const f of fs.existsSync(q) ? fs.readdirSync(q) : []) if (f.endsWith(".jsx") && !files.includes(f)) files.push(f); }, 5);
  await new Promise((r) => setTimeout(r, 30));
  const stop = fakeListener(dir, (p) => ({ ok: true, id: p.id, data: { echo: p.args.query } }));
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => client.callTool({ name: "list_layers", arguments: { query: "q" + i } })));
  stop();
  clearInterval(watcher);
  rs.forEach((r, i) => assert.equal(JSON.parse(r.content[0].text).echo, "q" + i, "answer matches its own call"));
  assert.ok(files.length <= 3, `20 calls used ${files.length} queue files`);
  await client.close();
});

// Interface guard: any change to tool names, input/output schemas or annotations
// must be deliberate. Regenerate with: UPDATE_SNAPSHOT=1 npm test
test("tools/list matches the committed snapshot", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  // icons come from local files (PNG only after npm run icon): leave them out
  const current = tools.map(({ icons, ...t }) => t);
  const file = path.join(root, "test", "tools-list.snapshot.json");
  if (process.env.UPDATE_SNAPSHOT === "1" || !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(current, null, 1) + String.fromCharCode(10));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(current, saved, "tools/list changed: run UPDATE_SNAPSHOT=1 npm test if intended");
});

test("an undo group makes one undo call revert every grouped call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-undo-"));
  const seen = [];
  const stop = fakeListener(dir, (p) => { seen.push(p); return { ok: true, id: p.id, data: { name: "x" } }; });
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir, AE_MCP_NO_COALESCE: "1" });
  await client.callTool({ name: "begin_undo_group", arguments: { name: "idea" } });
  for (let i = 0; i < 3; i++) await client.callTool({ name: "create_null_layer", arguments: { name: "n" + i } });
  await client.callTool({ name: "list_layers", arguments: {} }); // read-only: not a step
  const end = JSON.parse((await client.callTool({ name: "end_undo_group", arguments: {} })).content[0].text);
  assert.equal(end.steps, 3);
  const u = await client.callTool({ name: "undo", arguments: {} });
  assert.match(u.content[0].text, /3 step/);
  assert.equal(seen.at(-1).tool, "undo");
  assert.equal(seen.at(-1).args.steps, 3);
  // the group is consumed: a plain undo afterwards is one step again
  await client.callTool({ name: "undo", arguments: {} });
  assert.equal(seen.at(-1).args.steps, undefined);
  stop();
  await client.close();
});
