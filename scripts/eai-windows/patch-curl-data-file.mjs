// EKS-606: bundled skills/paperclip/scripts/{paperclip-issue-update,paperclip-upload-artifact}.sh
// pass the JSON payload to curl as a command-line argument (--data-binary "$payload"). On Windows,
// bash (MSYS) -> native curl.exe crosses a codepage boundary there and mangles non-ASCII UTF-8
// bytes (Polish diacritics, em dash, arrows) even though the payload itself is valid UTF-8.
// Fix: write the payload to a temp file first and pass it with --data-binary @file, same pattern
// already used by scripts/paperclip-curl.sh (EKS-447) and curl -d @payload.json (EKS-460).
// Usage: node patch-curl-data-file.mjs <file...> [--check]
// --check: change nothing, exit 1 if any given file still has the unpatched argument form.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((a) => a !== "--check");

const patchGroups = [
  {
    match: (name) => name === "paperclip-issue-update.sh",
    patches: [
      {
        old: 'max_attempts=2\nattempt=1\nwhile :; do',
        new:
          'payload_file="$(mktemp)"\n' +
          'trap \'rm -f "$payload_file"\' EXIT\n' +
          'printf \'%s\' "$payload" >"$payload_file"\n' +
          '\n' +
          'max_attempts=2\nattempt=1\nwhile :; do',
      },
      {
        old: '      --data-binary "$payload" \\',
        new: '      --data-binary @"$payload_file" \\',
      },
    ],
  },
  {
    match: (name) => name === "paperclip-upload-artifact.sh",
    patches: [
      {
        old:
          '  local response_file\n  local status_code\n\n  response_file="$(helper_response_file)"\n' +
          '  if [[ -n "$body" ]]; then\n    status_code="$(',
        new:
          '  local response_file\n  local status_code\n  local body_file\n\n' +
          '  response_file="$(helper_response_file)"\n' +
          '  if [[ -n "$body" ]]; then\n' +
          '    body_file="$(mktemp)"\n' +
          '    printf \'%s\' "$body" >"$body_file"\n' +
          '    status_code="$(',
      },
      {
        old: "        --data-binary \"$body\"\n    )\"\n  else",
        new: "        --data-binary @\"$body_file\"\n    )\"\n    rm -f \"$body_file\"\n  else",
      },
    ],
  },
];

let totalMissing = 0;
let sawAnyRelevant = false;

for (const file of files) {
  const base = file.replace(/^.*[\\/]/, "");
  const group = patchGroups.find((g) => g.match(base));
  if (!group) {
    console.log(`${file}: no patch defined for this filename, skipped`);
    continue;
  }
  sawAnyRelevant = true;

  let src = readFileSync(file, "utf8");
  let applied = 0;
  let alreadyDone = 0;
  let missing = 0;

  for (const p of group.patches) {
    if (src.includes(p.new)) {
      alreadyDone++;
    } else if (src.includes(p.old)) {
      src = src.replace(p.old, p.new);
      applied++;
    } else {
      missing++;
    }
  }

  if (check) {
    if (missing > 0 || applied > 0) {
      console.error(`${file}: not patched (needs=${applied + missing}, missing=${missing})`);
      totalMissing += applied + missing;
    } else {
      console.log(`${file}: OK (already patched)`);
    }
    continue;
  }

  if (applied > 0) {
    writeFileSync(file, src);
    console.log(`${file}: patched ${applied} spot(s)`);
  } else if (missing === 0) {
    console.log(`${file}: already patched`);
  }
  if (missing > 0) {
    console.error(`${file}: ${missing} expected pattern(s) not found - file shape changed, review manually`);
    totalMissing += missing;
  }
}

if (!sawAnyRelevant) {
  console.error("no recognized paperclip-issue-update.sh / paperclip-upload-artifact.sh files given");
  process.exit(1);
}

if (totalMissing > 0) process.exit(1);
if (check) console.log("curl --data-binary file patch: OK");
