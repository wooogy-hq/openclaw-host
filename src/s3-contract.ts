/**
 * S3 layout contract.
 *
 * These prefixes are a published shape, not an internal detail: a
 * `serverless-openclaw` deployment can share the same bucket, and the two sides
 * only see each other's state while the strings match. Changing one without the
 * other does not error — it silently splits the state in two, which is the
 * expensive way to find out.
 *
 * If you are not sharing a bucket with such a deployment, none of this
 * constrains you. Point DATA_BUCKET at your own bucket, or set
 * BACKUP_ENABLED=false, and the layout is simply where your own files land.
 *
 *   workspaces/{userId}/...                        workspace files
 *   sessions/{userId}/agents/{agentId}/sessions/   per-agent transcripts
 *   gateway port                                   18789 (loopback)
 *
 * `SESSION_DEFAULT_AGENT` is the one value with an external obligation: the
 * serverless side writes the `default` agent to that exact path. Host-only
 * agents get their own prefixes alongside it and are free to be named anything.
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
