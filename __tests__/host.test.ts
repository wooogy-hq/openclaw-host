import { describe, it, expect, vi } from "vitest";
import { startup, shutdown, type HostDeps } from "../src/host.js";
import { loadConfig } from "../src/config.js";

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
    expect(deps.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "bucket",
        prefix: "sessions/u1/agents/default/sessions",
        localPath: "/home/oc/agents/default/sessions",
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
        prefix: "sessions/u1/agents/default/sessions",
        localPath: "/home/oc/agents/default/sessions",
      }),
    );
  });
});
