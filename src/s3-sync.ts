/**
 * Recursive S3 <-> local filesystem sync.
 *
 * The S3 client is injectable (`client`) so the sync can be tested without a
 * bucket, and both functions return the number of files transferred.
 *
 * Mirror semantics are upload/overwrite only; objects are never deleted.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "node:fs";
import * as path from "node:path";

/** Minimal structural type so tests can inject a fake client. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface SyncParams {
  bucket: string;
  prefix: string;
  localPath: string;
  region?: string;
  /** Inject a client (tests); defaults to a real S3Client. */
  client?: S3Like;
  /**
   * Absolute path to a JSON manifest enabling INCREMENTAL backup: a file is
   * re-uploaded only when its size+mtime differs from the last upload. Without
   * it, backup falls back to re-uploading everything (legacy behaviour).
   */
  manifestPath?: string;
  /** Directory names skipped during backup (defaults to DEFAULT_EXCLUDE_DIRS). */
  exclude?: ReadonlySet<string>;
}

/**
 * Reconstructible / ephemeral directories that must NOT be mirrored to S3.
 * Backing these up re-uploaded tens of thousands of files every cycle (a
 * cloned repo's node_modules + .git alone was ~85% of the workspace), which
 * ran the S3 request bill into the ground. They're rebuildable from
 * package.json / the git remote, so they have no place in shared state.
 */
export const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".pnpm-store", // pnpm's content-addressed store — 72k files, refetchable
  ".git",
  ".next",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
]);

type Manifest = Record<string, string>;

function loadManifest(manifestPath?: string): Manifest {
  if (!manifestPath) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    return {}; // missing/corrupt → treat as a full backup
  }
}

function saveManifest(manifestPath: string | undefined, manifest: Manifest): void {
  if (!manifestPath) return;
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  } catch (err) {
    console.warn("[s3-sync] manifest write failed (next backup re-uploads):", err);
  }
}

interface ListResponse {
  Contents?: Array<{ Key?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

interface GetResponse {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

/** Download every object under `prefix/` into `localPath`. Returns file count. */
export async function restoreFromS3(params: SyncParams): Promise<number> {
  const client = params.client ?? new S3Client({ region: params.region });
  const { bucket, prefix, localPath } = params;
  let restored = 0;

  try {
    let continuationToken: string | undefined;
    do {
      const listResp = (await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      )) as ListResponse;

      for (const obj of listResp.Contents ?? []) {
        if (!obj.Key || obj.Key.endsWith("/")) continue;

        const relativePath = obj.Key.slice(prefix.length).replace(/^\//, "");
        if (!relativePath) continue;

        const localFilePath = path.join(localPath, relativePath);
        fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

        const getResp = (await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
        )) as GetResponse;

        if (getResp.Body) {
          const bytes = await getResp.Body.transformToByteArray();
          fs.writeFileSync(localFilePath, bytes);
          restored += 1;
        }
      }

      continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch {
    // Restore failure is non-fatal (first launch has no data).
    console.log("[s3-sync] nothing to restore (or S3 error)");
  }

  return restored;
}

/**
 * Upload files under `localPath` to `prefix/`, skipping excluded directories
 * and — when a manifest is supplied — files unchanged since the last backup.
 * Returns the number of files actually uploaded this run.
 */
export async function backupToS3(params: SyncParams): Promise<number> {
  const client = params.client ?? new S3Client({ region: params.region });
  const { bucket, prefix, localPath } = params;
  const exclude = params.exclude ?? DEFAULT_EXCLUDE_DIRS;

  if (!fs.existsSync(localPath)) return 0;
  const manifest = loadManifest(params.manifestPath);
  let uploaded = 0;
  let manifestDirty = false;

  async function uploadDir(dirPath: string, s3Prefix: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue; // node_modules/.git/... never go to S3
        // A nested dir with its own .git is a cloned repo or submodule — it
        // lives on its git remote, so it has no place in S3 state. (The backup
        // ROOT may itself be a git repo; we only skip NESTED ones, never the
        // root's own loose files.)
        if (fs.existsSync(path.join(fullPath, ".git"))) continue;
        await uploadDir(fullPath, `${s3Prefix}/${entry.name}`);
      } else if (entry.isFile()) {
        const key = `${s3Prefix}/${entry.name}`;
        const st = fs.statSync(fullPath);
        const sig = `${st.mtimeMs}:${st.size}`;
        if (manifest[key] === sig) continue; // unchanged since last upload — skip the PUT
        const fileBody = fs.readFileSync(fullPath);
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fileBody }));
        manifest[key] = sig;
        manifestDirty = true;
        uploaded += 1;
      }
    }
  }

  await uploadDir(localPath, prefix);
  if (manifestDirty) saveManifest(params.manifestPath, manifest);
  return uploaded;
}
