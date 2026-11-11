// Copies the ExtendScript runtime next to the compiled server.
import * as fs from "node:fs";
fs.mkdirSync("build/jsx", { recursive: true });
fs.copyFileSync("src/jsx/runtime.jsx", "build/jsx/runtime.jsx");
const idx = "build/index.js";
const src = fs.readFileSync(idx, "utf8");
if (!src.startsWith("#!")) fs.writeFileSync(idx, "#!/usr/bin/env node\n" + src);
console.log("assets copied");
