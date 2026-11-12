// Parses every ExtendScript file as ECMAScript 3: After Effects' engine rejects
// let/const, arrow functions, template literals, reserved words as property names...
// Also rejects constructs ExtendScript parses but evaluates WRONGLY:
//  - chained conditionals without parentheses (a ? x : b ? y : z), which ExtendScript
//    groups left-to-right: "left" === "left" ? 0 : s === "right" ? 1 : 2 gives 2.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "acorn";

const roots = ["src/jsx", "bridge"];
let bad = 0, n = 0;

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v.type === "string") walk(v, visit);
  }
}

for (const dir of roots) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsx"))) {
    const file = path.join(dir, f);
    n++;
    const src = fs.readFileSync(file, "utf8");
    try {
      const ast = parse(src, { ecmaVersion: 3, allowReturnOutsideFunction: true, allowReserved: false, preserveParens: true, locations: true });
      const problems = [];
      walk(ast, (node) => {
        if (node.type === "ConditionalExpression" && (node.alternate.type === "ConditionalExpression" || node.consequent.type === "ConditionalExpression")) {
          problems.push(`line ${node.loc.start.line}: nested ?: without parentheses (ExtendScript evaluates it wrongly)`);
        }
      });
      if (problems.length) {
        bad++;
        for (const p of problems) console.error(`${file}: ${p}`);
      }
    } catch (e) {
      bad++;
      console.error(`${file}: ${e.message}`);
    }
  }
}
console.log(`ES3 check: ${n - bad}/${n} files OK`);
process.exit(bad ? 1 : 0);
