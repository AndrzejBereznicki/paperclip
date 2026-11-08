// EKS-600: @paperclipai/adapter-utils's writePaperclipClaudeSettings() (acpx-engine/execute.js)
// hardcodes "Bash(curl:*)", "Bash(env:*)", "Bash(env)" into every agent workspace's
// .claude/settings.local.json allow list on every run, re-merging them back in even after
// EKS-447/EKS-460 removed them and added a global ~/.claude/settings.json deny for the same
// patterns. The global deny still wins (deny > local allow), but the local file re-widening
// itself is the bug being fixed here - it's confusing to audit and a latent risk if the global
// deny is ever loosened. These two Bash() entries are unnecessary: workspaces already get
// `Bash(<cwd>/scripts/paperclip:*)` / `Bash(<cwd>/scripts/paperclip-issue-update.sh:*)` for the
// one thing they're there for (the Paperclip API wrapper), and `Bash(env)/Bash(env:*)` isn't
// needed to read PAPERCLIP_* vars (the shell already has them; Read/the agent's own tools cover
// inspection). This is a hand-patch to node_modules - not a fork-repo change - because this file
// ships as compiled dist/ in the npm package, not esbuild-overlaid server/src.
// Usage: node patch-no-wide-bash-allow.mjs <execute.js...> [--check]
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((a) => a !== "--check");

const OLD = `    const paperclipAllow = uniqueSorted([
        "Bash(curl:*)",
        "Bash(env:*)",
        "Bash(env)",
        \`Bash(\${input.cwd}/scripts/paperclip-issue-update.sh:*)\`,
        \`Bash(\${input.cwd}/scripts/paperclip:*)\`,
    ]);`;
const NEW = `    const paperclipAllow = uniqueSorted([
        \`Bash(\${input.cwd}/scripts/paperclip-issue-update.sh:*)\`,
        \`Bash(\${input.cwd}/scripts/paperclip:*)\`,
    ]);`;

if (files.length === 0) {
  console.error("usage: node patch-no-wide-bash-allow.mjs <execute.js...> [--check]");
  process.exit(1);
}

let totalMissing = 0;

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`${file}: cannot read (${err.message})`);
    totalMissing++;
    continue;
  }

  const alreadyDone = src.includes(NEW);
  const needsPatch = src.includes(OLD);

  if (check) {
    if (alreadyDone) {
      console.log(`${file}: OK (already patched)`);
    } else {
      console.error(`${file}: not patched${needsPatch ? "" : " - expected pattern not found, review manually"}`);
      totalMissing++;
    }
    continue;
  }

  if (alreadyDone) {
    console.log(`${file}: already patched`);
  } else if (needsPatch) {
    writeFileSync(file, src.replace(OLD, NEW));
    console.log(`${file}: patched`);
  } else {
    console.error(`${file}: expected pattern not found - file shape changed, review manually`);
    totalMissing++;
  }
}

if (totalMissing > 0) process.exit(1);
if (check) console.log("no-wide-bash-allow patch: OK");
