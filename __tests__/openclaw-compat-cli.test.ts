import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.resolve("bin/openclaw-compat.mjs");
const FIXTURE = path.resolve("__tests__/fixtures/legacy-openclaw.json");

/** Run the CLI, capturing output whether it exits 0 or not. */
function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf-8" }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function fixtureCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-compat-"));
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, readFileSync(FIXTURE, "utf-8"));
  return file;
}

describe("openclaw-compat CLI", () => {
  beforeAll(() => {
    if (!existsSync("dist/openclaw-compat.js")) {
      execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    }
  });

  it("reads --version wherever it appears, not by position", () => {
    // The bug this guards: `args.indexOf("--version")` is -1 when the flag is
    // absent, so args[-1 + 1] handed the config path in as the version string.
    // It parsed to nothing, capabilities fell back to the older shape, and the
    // file was rewritten for a gateway nobody asked for — silently.
    const file = fixtureCopy();
    const after = run(["--version", "2026.9.4", file]);
    expect(after.out).toContain("2026.9.4");
    expect(after.out).toContain("roster=entries");

    const before = run([file, "--version", "2026.9.4"]);
    expect(before.out).toContain("roster=entries");
  });

  it("picks the config path even when a version is given first", () => {
    const file = fixtureCopy();
    const r = run(["--version", "2026.9.4", file, "--write"]);
    expect(r.code).toBe(0);
    // The rewrite landed on the config, not on a file named after the version.
    expect(JSON.parse(readFileSync(file, "utf-8")).agents.entries).toBeDefined();
  });

  it("refuses rather than guessing when the version is unreadable", () => {
    const r = run([fixtureCopy(), "--version", "not-a-version"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/could not read a version/);
  });

  it("rejects an unknown flag instead of treating it as the config path", () => {
    const r = run([fixtureCopy(), "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown flag/);
  });

  it("leaves the file alone without --write", () => {
    const file = fixtureCopy();
    const original = readFileSync(file, "utf-8");
    run([file, "--version", "2026.9.4"]);
    expect(readFileSync(file, "utf-8")).toBe(original);
  });
});
