// EKS-474/EKS-577: upstream spawns `git` via execFileSync without windowsHide, so every
// heartbeat flashes a console window on Windows. Adds `windowsHide: true` to every
// execFileSync*("git", args, {...}) call in the bundled CLI/server.
// Usage: node patch-windows-hide.mjs <dist/index.js> [--check]
// --check: change nothing, exit 1 if any call is still missing windowsHide.
import { readFileSync, writeFileSync } from "node:fs";

const [file, flag] = process.argv.slice(2);
const check = flag === "--check";
let src = readFileSync(file, "utf8");

// Index just past the expression starting at i (stops at a top-level `,` or `)`).
function skipExpr(s, i) {
  const stack = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      for (i++; s[i] !== c; i++) if (s[i] === "\\") i++;
      i++;
      continue;
    }
    if (c === "`") {
      for (i++; s[i] !== "`"; i++) {
        if (s[i] === "\\") i++;
        else if (s[i] === "$" && s[i + 1] === "{") i = skipExpr(s, i + 2); // lands on the closing }
      }
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.length === 0) return i;
      stack.pop();
    } else if (c === "," && stack.length === 0) return i;
    i++;
  }
  return i;
}

const re = /execFileSync\d*\(\s*"git"\s*,/g;
const edits = [];
const missing = [];
for (let m; (m = re.exec(src)); ) {
  const argsEnd = skipExpr(src, m.index + m[0].length);
  let j = argsEnd;
  const line = src.slice(0, m.index).split("\n").length;
  if (src[j] === ",") j++;
  while (/\s/.test(src[j])) j++;
  if (src[j] === "{") {
    const objEnd = skipExpr(src, j);
    if (!src.slice(j, objEnd).includes("windowsHide")) edits.push({ at: j + 1, text: " windowsHide: true,", line });
  } else if (src[j] === ")") {
    edits.push({ at: argsEnd, text: ", { windowsHide: true }", line });
  } else {
    missing.push(line);
  }
}

if (check) {
  const bad = [...edits.map((e) => e.line), ...missing];
  if (bad.length) {
    console.error(`windowsHide missing on git calls at lines: ${bad.join(", ")}`);
    process.exit(1);
  }
  console.log("windowsHide: all git calls patched");
  process.exit(0);
}

for (const e of edits.sort((a, b) => b.at - a.at)) src = src.slice(0, e.at) + e.text + src.slice(e.at);
if (edits.length) writeFileSync(file, src);
console.log(`windowsHide: patched ${edits.length} git call(s)`);
if (missing.length) {
  console.error(`cannot patch git calls with non-literal options at lines: ${missing.join(", ")}`);
  process.exit(1);
}
