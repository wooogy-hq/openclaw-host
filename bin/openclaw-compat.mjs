#!/usr/bin/env node
// Reshape an openclaw.json for a given OpenClaw version, without booting the host.
//
//   node bin/openclaw-compat.mjs /state/openclaw.json                 # for the installed CLI
//   node bin/openclaw-compat.mjs /state/openclaw.json --version 2026.9.2
//   node bin/openclaw-compat.mjs /state/openclaw.json --write
//
// The host applies the same transform on every boot (src/index.ts), so this is
// for the cases where the host is not the one writing: previewing an upgrade
// against a stopped gateway, or repairing a config by hand. Same module, so the
// two cannot drift.
//
// Why not `openclaw doctor --fix`: doctor prompts before these changes and
// `--non-interactive` skips them ("safe migrations only"). A container has no
// TTY, so an unattended upgrade boots on a config the new gateway rejects.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let compat;
try {
  compat = await import(new URL("../dist/openclaw-compat.js", import.meta.url));
} catch {
  console.error("dist/ not built. Run: npm run build");
  process.exit(2);
}

// Hand-rolled, but explicitly: `indexOf("--version")` returns -1 when the flag
// is absent, and args[-1 + 1] is args[0] — the config path, silently used as a
// version string. It parses to nothing, capabilities fall back to the older
// shape, and the file is rewritten for the wrong gateway without a word.
const args = process.argv.slice(2);
let file;
let pinned;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") {
    pinned = args[++i];
  } else if (args[i] === "--write") {
    continue;
  } else if (args[i].startsWith("--")) {
    console.error(`unknown flag: ${args[i]}`);
    process.exit(2);
  } else if (file === undefined) {
    file = args[i];
  }
}
const write = args.includes("--write");

if (!file) {
  console.error("usage: openclaw-compat.mjs <openclaw.json> [--version X.Y.Z] [--write]");
  process.exit(2);
}

let versionText = pinned;
if (!versionText) {
  try {
    versionText = execFileSync("openclaw", ["--version"], { encoding: "utf-8" });
  } catch {
    console.error("no --version given and `openclaw --version` failed");
    process.exit(2);
  }
}
const version = compat.parseVersion(versionText);
// The host may fall back to the older shape on an unreadable version — it has a
// gateway to keep alive. A CLI run has no such excuse: guessing here rewrites
// someone's config for a gateway they did not name.
if (!version) {
  console.error(`could not read a version from: ${versionText.trim()}`);
  process.exit(2);
}
const caps = compat.capabilitiesFor(version);

const config = JSON.parse(readFileSync(file, "utf-8"));
const changes = compat.applyCompat(config, caps);

console.log(`target: openclaw ${version?.join(".") ?? "unknown"} (roster=${caps.rosterKey})`);
if (changes.length === 0) {
  console.log("already in the right shape");
  process.exit(0);
}
for (const c of changes) console.log(" -", c);

if (write) {
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
  console.log(`\nwrote ${file}. Verify with: openclaw config validate`);
} else {
  console.log("\n(dry run — pass --write to apply)");
}
