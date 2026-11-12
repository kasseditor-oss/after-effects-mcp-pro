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
function fakeListener(dir, respond) {
  const q = path.join(dir, "queue");
  let n = 0;
  const timer = setInterval(() => {
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ time: Date.now(), version: "2.0.1", ae: "fake", paused: false, executed: n, project: "" }));
    for (const f of fs.existsSync(q) ? fs.readdirSync(q) : []) {
      if (!f.endsWith(".jsx")) continue;
      const src = fs.readFileSync(path.join(q, f), "utf8");
      fs.rmSync(path.join(q, f));
      const m = src.match(/\.run\((".*"), ("[^"]+\.json")\);/);
      const payload = JSON.parse(JSON.parse(m[1]));
      const resultPath = JSON.parse(m[2]);
      fs.writeFileSync(resultPath, JSON.stringify(respond(payload, n++)));
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
