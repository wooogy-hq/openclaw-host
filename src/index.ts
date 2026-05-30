/**
 * openclaw-host entry point.
 *
 * Lifecycle (see docs/spec.md):
 *   1. Load + validate env config
 *   2. Restore workspace + sessions from S3 (shared bucket)
 *   3. Write openclaw.json with native channels enabled
 *   4. Spawn `openclaw gateway run` and supervise it
 *   5. Periodic S3 backup; on SIGTERM/SIGINT, final backup then exit
 *
 * NOTE: Implementation is gated on spec approval. This is a stub.
 */

async function main(): Promise<void> {
  throw new Error("openclaw-host: not implemented yet — see docs/spec.md");
}

main().catch((err) => {
  console.error("[openclaw-host] fatal:", err);
  process.exit(1);
});
