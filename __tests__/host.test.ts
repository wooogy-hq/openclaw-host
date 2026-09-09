import { describe, it, expect, vi } from "vitest";
import { startup, shutdown, type HostDeps } from "../src/host.js";
import { loadConfig } from "../src/config.js";
import { capabilitiesFor } from "../src/openclaw-compat.js";

function makeDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  const config = loadConfig({
    DATA_BUCKET: "bucket",
    USER_ID: "u1",
    TELEGRAM_BOT_TOKEN: "t",
    WORKSPACE_DIR: "/data/ws",
    OPENCLAW_STATE_DIR: "/home/oc",
  });
  return {
    config,
    restore: vi.fn(async () => 0),
    backup: vi.fn(async () => 0),
    writeConfigFile: vi.fn(),
    supervisor: { start: vi.fn(), waitForExit: vi.fn(async () => 0), stop: vi.fn() },
    // Injected so backup targets are asserted without touching the real fs.
    listAgentIds: () => ["main"],
    ...overrides,
  };
}

describe("startup", () => {
  it("restores workspace and sessions from the shared S3 prefixes", async () => {
    const deps = makeDeps();
    await startup(deps);

    expect(deps.restore).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "bucket", prefix: "workspaces/u1", localPath: "/data/ws" }),
    );
    // The whole agents/ parent comes down: ids can't be scanned before restore.
    expect(deps.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "bucket",
        prefix: "sessions/u1/agents",
        localPath: "/home/oc/agents",
      }),
    );
  });

  it("writes openclaw.json with the telegram channel enabled, then starts the gateway", async () => {
    const deps = makeDeps();
    await startup(deps);

    expect(deps.writeConfigFile).toHaveBeenCalledTimes(1);
    const [cfgPath, obj] = (deps.writeConfigFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cfgPath).toBe("/home/oc/openclaw.json");
    expect((obj.channels as any).telegram.enabled).toBe(true);
    expect(deps.supervisor.start).toHaveBeenCalledTimes(1);
  });

  it("restores before starting the gateway", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      restore: vi.fn(async () => {
        order.push("restore");
        return 0;
      }),
      supervisor: {
        start: vi.fn(() => order.push("start")),
        waitForExit: vi.fn(async () => 0),
        stop: vi.fn(),
      },
    });
    await startup(deps);
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("start"));
  });

  it("starts without restoring when startup restore is disabled", async () => {
    const deps = makeDeps();
    deps.config.restoreOnStart = false;

    await startup(deps);

    expect(deps.restore).not.toHaveBeenCalled();
    expect(deps.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(deps.supervisor.start).toHaveBeenCalledTimes(1);
  });
});

describe("shutdown", () => {
  it("backs up workspace and sessions to the shared S3 prefixes", async () => {
    const deps = makeDeps();
    await shutdown(deps);

    expect(deps.backup).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "bucket", prefix: "workspaces/u1", localPath: "/data/ws" }),
    );
    expect(deps.backup).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "bucket",
        prefix: "sessions/u1/agents/main/sessions",
        localPath: "/home/oc/agents/main/sessions",
      }),
    );
  });

  it("backs up one session prefix per agent, so a new agent needs no code change", async () => {
    const deps = makeDeps({ listAgentIds: () => ["main", "work"] });
    await shutdown(deps);

    const prefixes = (deps.backup as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].prefix);
    expect(prefixes).toEqual([
      "workspaces/u1",
      "sessions/u1/agents/main/sessions",
      "sessions/u1/agents/work/sessions",
    ]);
  });

  it("skips S3 entirely when BACKUP_ENABLED=false", async () => {
    const deps = makeDeps();
    deps.config = { ...deps.config, backupEnabled: false };
    await shutdown(deps);

    expect(deps.backup).not.toHaveBeenCalled();
  });

  it("backs up only the workspace when no agent has a session dir yet", async () => {
    const deps = makeDeps({ listAgentIds: () => [] });
    await shutdown(deps);

    expect(deps.backup).toHaveBeenCalledTimes(1);
    expect(deps.backup).toHaveBeenCalledWith(expect.objectContaining({ prefix: "workspaces/u1" }));
  });
});

describe("backup targets follow the gateway's storage layout", () => {
  it("syncs a session dir per agent on pre-2026.8.1 gateways", async () => {
    const deps = makeDeps({
      config: { ...makeDeps().config, backupEnabled: true },
      capabilities: capabilitiesFor([2026, 7, 1]),
    });
    await shutdown(deps);

    const prefixes = (deps.backup as ReturnType<typeof vi.fn>).mock.calls.map(
      ([p]) => p.prefix as string,
    );
    expect(prefixes).toEqual(["workspaces/u1", "sessions/u1/agents/main/sessions"]);
  });

  it("stops syncing session dirs once transcripts live in SQLite", async () => {
    // From 2026.8.1 those .jsonl files are exports and orphans; the live
    // transcript is in agents/<id>/agent/openclaw-agent.sqlite, which also holds
    // the OAuth store and so must not be pushed to S3. Copying the old path
    // would look like a backup and restore nothing.
    const deps = makeDeps({
      config: { ...makeDeps().config, backupEnabled: true },
      capabilities: capabilitiesFor([2026, 9, 2]),
    });
    await shutdown(deps);

    const prefixes = (deps.backup as ReturnType<typeof vi.fn>).mock.calls.map(
      ([p]) => p.prefix as string,
    );
    expect(prefixes).toEqual(["workspaces/u1"]);
    expect(prefixes.some((p) => p.includes("agent"))).toBe(false);
  });

  it("says so at startup instead of quietly shrinking the backup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      config: { ...makeDeps().config, backupEnabled: true },
      capabilities: capabilitiesFor([2026, 9, 2]),
    });
    await startup(deps);

    expect(warn.mock.calls.flat().join(" ")).toMatch(/backup sqlite/);
    warn.mockRestore();
  });
});
