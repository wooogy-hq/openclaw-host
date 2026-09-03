import { describe, it, expect } from "vitest";
import {
  SESSION_S3_PREFIX,
  SESSION_DEFAULT_AGENT,
  WORKSPACE_S3_PREFIX,
  GATEWAY_PORT,
  workspacePrefix,
  sessionsPrefix,
  agentsPrefix,
} from "../src/s3-contract.js";

// Drift guard: these literals MUST match serverless-openclaw
// (packages/shared/src/constants.ts). If this test fails, the shared-bucket
// layout has diverged and cross-environment state sharing will break.
describe("S3 layout contract", () => {
  it("pins the literal prefix values", () => {
    expect(SESSION_S3_PREFIX).toBe("sessions");
    expect(SESSION_DEFAULT_AGENT).toBe("default");
    expect(WORKSPACE_S3_PREFIX).toBe("workspaces");
    expect(GATEWAY_PORT).toBe(18789);
  });

  it("builds the workspace prefix", () => {
    expect(workspacePrefix("u1")).toBe("workspaces/u1");
  });

  it("builds the sessions prefix matching the serverless container layout", () => {
    expect(sessionsPrefix("u1")).toBe("sessions/u1/agents/default/sessions");
  });

  it("builds a per-agent sessions prefix for host-only agents", () => {
    expect(sessionsPrefix("u1", "main")).toBe("sessions/u1/agents/main/sessions");
    expect(sessionsPrefix("u1", "work")).toBe("sessions/u1/agents/work/sessions");
  });

  it("builds the agents parent prefix used on restore", () => {
    expect(agentsPrefix("u1")).toBe("sessions/u1/agents");
  });
});
