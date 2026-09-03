/**
 * S3 layout contract — VENDORED from the serverless-openclaw deployment.
 *
 * These values MUST stay byte-for-byte identical to the serverless side
 * (`@serverless-openclaw/shared`) so that openclaw-host and the serverless
 * stack can share the same bucket and see each other's workspace/session
 * state. Changing any value here without changing it there (or vice versa)
 * silently breaks cross-environment state sharing.
 *
 * Source of truth on the serverless side:
 *   packages/shared/src/constants.ts
 *     SESSION_S3_PREFIX     = "sessions"
 *     SESSION_DEFAULT_AGENT = "default"
 *   packages/container/src/startup.ts / lambda-agent workspace-sync.ts
 *     workspace prefix      = "workspaces"
 *     gateway port          = 18789
 */

/** Top-level prefix for OpenClaw session transcripts. */
export const SESSION_S3_PREFIX = "sessions";

/** Default OpenClaw agent id used in the session path. */
export const SESSION_DEFAULT_AGENT = "default";

/** Top-level prefix for the user's workspace files (.git, AGENTS.md, code). */
export const WORKSPACE_S3_PREFIX = "workspaces";

/** Default OpenClaw gateway port (loopback). */
export const GATEWAY_PORT = 18789;

/** `s3://{bucket}/workspaces/{userId}` */
export function workspacePrefix(userId: string): string {
  return `${WORKSPACE_S3_PREFIX}/${userId}`;
}

/** `s3://{bucket}/sessions/{userId}/agents` — the parent of every agent's
 *  session dir. Used on restore, where the local agent dirs do not exist yet so
 *  the ids cannot be enumerated from disk. */
export function agentsPrefix(userId: string): string {
  return `${SESSION_S3_PREFIX}/${userId}/agents`;
}

/** `s3://{bucket}/sessions/{userId}/agents/{agentId}/sessions`
 *
 *  The `default` case must stay byte-for-byte identical to the serverless
 *  contract (see the file header); other agent ids are host-only and never
 *  reach the serverless side. */
export function sessionsPrefix(userId: string, agentId: string = SESSION_DEFAULT_AGENT): string {
  return `${agentsPrefix(userId)}/${agentId}/sessions`;
}
