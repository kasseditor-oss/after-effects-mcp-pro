// Parses every ExtendScript file as ECMAScript 3: After Effects' engine rejects
// let/const, arrow functions, template literals, reserved words as property names...
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "acorn";

const roots = ["src/jsx", "bridge"];
let bad = 0, n = 0;
for (const dir of roots) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsx"))) {
    const file = path.join(dir, f);
    n++;
    try {
      parse(fs.readFileSync(file, "utf8"), { ecmaVersion: 3, allowReturnOutsideFunction: true, allowReserved: false });
    } catch (e) {
      bad++;
      console.error(`${file}: ${e.message}`);
    }
  }
}
console.log(`ES3 check: ${n - bad}/${n} files OK`);
process.exit(bad ? 1 : 0);
