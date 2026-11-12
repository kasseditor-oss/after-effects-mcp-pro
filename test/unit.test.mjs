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
    // AE_MCP_PLATFORM=other: unit tests never talk to an After Effects that happens to be open
    env: { ...process.env, AE_MCP_BRIDGE_DIR: tmpBridge, AE_MCP_MODE: "listener", AE_MCP_PLATFORM: "other", ...env },
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
    assert.equal(t.icons, undefined, `${t.name}: the icon belongs in serverInfo only`);
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

test("macOS platform: install discovery and AppleScript command (runs on any OS)", async () => {
  const { findInstallsIn, appleScriptFor } = await import(new URL("../build/platform/macos.js", import.meta.url).href);
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-apps-"));
  for (const v of ["2025", "2026"]) {
    const d = path.join(apps, `Adobe After Effects ${v}`);
    fs.mkdirSync(path.join(d, `Adobe After Effects ${v}.app`), { recursive: true });
    fs.writeFileSync(path.join(d, "aerender"), "");
  }
  fs.mkdirSync(path.join(apps, "Adobe Premiere Pro 2026"));
  const found = findInstallsIn(apps);
  assert.deepEqual(found.map((i) => i.version), ["2026", "2025"]);
  assert.ok(found[0].executable.endsWith("Adobe After Effects 2026.app"));
  assert.ok(found[0].aerender);
  assert.equal(appleScriptFor('/Users/a "b"/x.jsx', "Adobe After Effects 2026"), 'tell application "Adobe After Effects 2026" to DoScriptFile "/Users/a \\"b\\"/x.jsx"');
});

test("platform selection and bridge folder per OS", async () => {
  const { platform } = await import(new URL("../build/platform/index.js", import.meta.url).href);
  const prev = process.env.AE_MCP_PLATFORM;
  process.env.AE_MCP_PLATFORM = "macos";
  assert.equal(platform().name, "macos");
  assert.ok(platform().userDataDir().endsWith(path.join("Library", "Application Support")));
  process.env.AE_MCP_PLATFORM = "windows";
  assert.equal(platform().name, "windows");
  if (prev === undefined) delete process.env.AE_MCP_PLATFORM; else process.env.AE_MCP_PLATFORM = prev;
});

test("tools/list stays small (no per-tool icons)", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  const bytes = Buffer.byteLength(JSON.stringify({ tools }));
  assert.ok(bytes < 120_000, `tools/list is ${bytes} bytes`);
});

test("ES3 check rejects chained conditionals (ExtendScript evaluates them wrongly)", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-es3-"));
  fs.mkdirSync(path.join(dir, "src", "jsx"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bridge"));
  fs.writeFileSync(path.join(dir, "src", "jsx", "bad.jsx"), "var s = 'a'; var k = s === 'a' ? 0 : s === 'b' ? 1 : 2;");
  fs.writeFileSync(path.join(dir, "bridge", "ok.jsx"), "var s = 'a'; var k = s === 'a' ? 0 : (s === 'b' ? 1 : 2);");
  let failed = false, out = "";
  try { execFileSync(process.execPath, [path.join(root, "scripts", "check-es3.mjs")], { cwd: dir, encoding: "utf8", stdio: "pipe" }); }
  catch (e) { failed = true; out = String(e.stderr); }
  assert.ok(failed, "chained ternary must fail the check");
  assert.match(out, /bad\.jsx: line 1: nested/);
  assert.doesNotMatch(out, /ok\.jsx/);
});

test("long single calls send heartbeat progress when a progressToken is given", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-beat-"));
  const q = path.join(dir, "queue");
  // fake AE: answers each command 5 s after it shows up, without progress files
  const pending = new Map();
  const timer = setInterval(() => {
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ time: Date.now(), version: "2.0.2", ae: "fake", paused: false, executed: 0, project: "" }));
    for (const f of fs.existsSync(q) ? fs.readdirSync(q) : []) {
      if (!f.endsWith(".jsx") || pending.has(f)) continue;
      const src = fs.readFileSync(path.join(q, f), "utf8");
      pending.set(f, setTimeout(() => {
        for (const m of src.matchAll(/\.run\((".*"), ("[^"]+\.json")\);/g)) {
          const payload = JSON.parse(JSON.parse(m[1]));
          fs.writeFileSync(JSON.parse(m[2]), JSON.stringify({ ok: true, id: payload.id, data: { created: true } }));
        }
        fs.rmSync(path.join(q, f), { force: true });
      }, 5000));
    }
  }, 30);
  await new Promise((r) => setTimeout(r, 80));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir, AE_MCP_ASSUME_RUNNING: "1" });
  const seen = [];
  const r = await client.callTool({ name: "new_project", arguments: { discardChanges: false } }, undefined, { onprogress: (p) => seen.push(p) });
  clearInterval(timer);
  assert.ok(!r.isError, r.content[0].text);
  assert.ok(seen.length >= 1, "at least one heartbeat during a 5 s call");
  assert.match(seen[0].message, /After Effects is working/);
  await client.close();
});

test("servers of different versions keep separate runtimes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-rt-"));
  // a runtime written by another (older) server, still recent: must survive
  const other = path.join(dir, "runtime", "2.0.1");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "runtime-abc.jsx"), "// other server");
  const stale = path.join(dir, "runtime", "1.0.0");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "runtime-old.jsx"), "// 8 days old");
  const old = Date.now() / 1000 - 8 * 24 * 3600;
  fs.utimesSync(path.join(stale, "runtime-old.jsx"), old, old);
  // two servers starting in parallel
  const a = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const b = await connect({ AE_MCP_BRIDGE_DIR: dir });
  const { SERVER_VERSION } = await import(new URL("../build/bridge.js", import.meta.url).href);
  assert.ok(fs.existsSync(path.join(other, "runtime-abc.jsx")), "a recent runtime of another version is kept");
  assert.ok(!fs.existsSync(path.join(stale, "runtime-old.jsx")), "runtimes untouched for 7+ days are removed");
  assert.equal(fs.readdirSync(path.join(dir, "runtime", SERVER_VERSION)).filter((f) => f.endsWith(".jsx")).length, 1);
  await a.close();
  await b.close();
});

test("AE_MCP_EVAL=off hides run_extendscript; AE_MCP_READONLY=1 exposes only read tools", async () => {
  const off = await connect({ AE_MCP_EVAL: "off" });
  const t1 = (await off.listTools()).tools.map((t) => t.name);
  assert.ok(!t1.includes("run_extendscript"));
  const r = await off.callTool({ name: "run_extendscript", arguments: { code: "return 1;" } });
  assert.equal(r.isError, true);
  const rb = await off.callTool({ name: "batch", arguments: { operations: [{ tool: "run_extendscript", args: { code: "return 1;" } }] } });
  assert.equal(rb.isError, true, "eval cannot sneak in through batch");
  await off.close();
  const legacy = await connect({ AE_MCP_DISABLE_EVAL: "1" });
  assert.ok(!(await legacy.listTools()).tools.some((t) => t.name === "run_extendscript"), "AE_MCP_DISABLE_EVAL=1 still works");
  await legacy.close();
  const ro = await connect({ AE_MCP_READONLY: "1" });
  const t2 = (await ro.listTools()).tools;
  for (const t of t2) assert.ok(/^(list_|get_|preview_)|^bridge_status$|^check_expressions$/.test(t.name) || t.annotations.readOnlyHint, `${t.name} listed in read-only mode`);
  assert.ok(!t2.some((t) => t.name === "create_composition" || t.name === "batch" || t.name === "run_extendscript"));
  const w = await ro.callTool({ name: "create_composition", arguments: { name: "x" } });
  assert.equal(w.isError, true);
  const st = JSON.parse((await ro.callTool({ name: "bridge_status", arguments: {} })).content[0].text);
  assert.deepEqual(st.modes, { eval: "on", readOnly: true, allowedDirs: null });
  await ro.close();
});

test("AE_MCP_ALLOWED_DIRS refuses outside paths, '..' and links before reaching After Effects", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-allow-"));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.png"), "x");
  // a directory link inside the allowed folder that points outside it
  fs.symlinkSync(outside, path.join(allowed, "link"), "junction");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aemcp-allowq-"));
  let reached = 0;
  const stop = fakeListener(dir, (p) => { reached++; return { ok: true, id: p.id, data: { imported: [{ id: 1, name: "a" }], errors: [] } }; });
  await new Promise((r) => setTimeout(r, 60));
  const client = await connect({ AE_MCP_BRIDGE_DIR: dir, AE_MCP_ALLOWED_DIRS: allowed });
  const cases = [
    { paths: [path.join(outside, "secret.png")] },
    { paths: [path.join(outside, "missing.png")] },
    { paths: [path.join(allowed, "..", "outside", "secret.png")] },
    { paths: [path.join(allowed, "link", "secret.png")] },
  ];
  const msgs = [];
  for (const a of cases) {
    const r = await client.callTool({ name: "import_files", arguments: a });
    assert.equal(r.isError, true, JSON.stringify(a));
    msgs.push(r.content[0].text);
  }
  assert.equal(new Set(msgs).size, 1, "same message whether or not the file exists");
  const viaBatch = await client.callTool({ name: "batch", arguments: { operations: [{ tool: "save_project", args: { path: path.join(outside, "p.aep") } }] } });
  assert.equal(viaBatch.isError, true);
  assert.equal(reached, 0, "nothing reached After Effects");
  const okCall = await client.callTool({ name: "import_files", arguments: { paths: [path.join(allowed, "img.png")] } });
  stop();
  assert.ok(!okCall.isError, okCall.content[0].text);
  assert.equal(reached, 1);
  await client.close();
});
