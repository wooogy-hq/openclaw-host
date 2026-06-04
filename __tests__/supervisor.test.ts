import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { GatewaySupervisor, type SpawnLike } from "../src/supervisor.js";

class FakeChild extends EventEmitter {
  kill = vi.fn((_signal?: string) => true);
  pid = 4242;
}

function fakeSpawn() {
  const child = new FakeChild();
  const spawn: SpawnLike = vi.fn(() => child as unknown as ReturnType<SpawnLike>);
  return { child, spawn };
}

describe("GatewaySupervisor", () => {
  it("spawns `openclaw gateway run` with the configured port and env on start", () => {
    const { child, spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, env: { FOO: "bar" }, spawn });
    sup.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("openclaw");
    expect(args).toEqual(["gateway", "run", "--port", "18789", "--bind", "loopback"]);
    expect((opts as { env: Record<string, string> }).env.FOO).toBe("bar");
    expect(child.listenerCount("exit")).toBeGreaterThan(0);
  });

  it("waitForExit resolves with the child exit code", async () => {
    const { child, spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, spawn });
    sup.start();
    const p = sup.waitForExit();
    child.emit("exit", 0, null);
    await expect(p).resolves.toBe(0);
  });

  it("stop forwards the signal to the child process", () => {
    const { child, spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, spawn });
    sup.start();
    sup.stop("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("throws if started twice", () => {
    const { spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, spawn });
    sup.start();
    expect(() => sup.start()).toThrow(/already/i);
  });

  it("handles the child 'error' event without crashing and resolves waitForExit", async () => {
    const { child, spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, spawn });
    sup.start();
    const p = sup.waitForExit();
    // ENOENT-style spawn failure (e.g. `openclaw` not on PATH).
    child.emit("error", new Error("spawn openclaw ENOENT"));
    await expect(p).resolves.toBeNull();
  });

  it("uses a custom command when provided", () => {
    const { spawn } = fakeSpawn();
    const sup = new GatewaySupervisor({ port: 18789, command: "/opt/bin/openclaw", spawn });
    sup.start();
    const [cmd] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("/opt/bin/openclaw");
  });
});
