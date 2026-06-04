/**
 * Supervises the `openclaw gateway run` child process.
 *
 * No internal restart loop: process supervision/restart is delegated to the
 * machine init system (systemd `Restart=always`, Docker restart policy). This
 * class owns spawning, signal forwarding, and reporting exit, so index.ts can
 * run a final S3 backup whenever the gateway exits (graceful or crash).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdio?: "inherit" },
) => ChildProcess;

export interface SupervisorOptions {
  port: number;
  env?: NodeJS.ProcessEnv;
  /** Path/name of the OpenClaw binary. Defaults to "openclaw" (on PATH). */
  command?: string;
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawn?: SpawnLike;
}

export class GatewaySupervisor {
  private readonly opts: SupervisorOptions;
  private readonly spawnFn: SpawnLike;
  private child: ChildProcess | null = null;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.spawnFn = opts.spawn ?? (nodeSpawn as SpawnLike);
  }

  start(): void {
    if (this.child) throw new Error("GatewaySupervisor already started");
    this.child = this.spawnFn(
      this.opts.command ?? "openclaw",
      // --bind loopback: don't expose the gateway on 0.0.0.0. openclaw 2026.6.x
      // refuses to start with the container-default bind=auto unless auth (token/
      // password) is set; we don't expose the gateway (native channels are
      // outbound), so loopback is correct and needs no token.
      ["gateway", "run", "--port", String(this.opts.port), "--bind", "loopback"],
      { env: this.opts.env ?? process.env, stdio: "inherit" },
    );
    this.child.on("exit", (code) => {
      console.log(`[supervisor] openclaw gateway exited with code ${code ?? "null"}`);
    });
    // Handle spawn failures (e.g. ENOENT when `openclaw` is not on PATH) so the
    // EventEmitter does not throw an unhandled 'error' and crash the process.
    this.child.on("error", (err) => {
      console.error("[supervisor] failed to spawn openclaw gateway:", err.message);
    });
  }

  /** Resolves with the child's exit code (or null on spawn error) when it exits. */
  waitForExit(): Promise<number | null> {
    const child = this.child;
    if (!child) throw new Error("GatewaySupervisor not started");
    return new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
  }

  /** Forward a termination signal to the gateway for graceful shutdown. */
  stop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal);
  }
}
