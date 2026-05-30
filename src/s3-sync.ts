/**
 * Recursive S3 <-> local filesystem sync — ported from serverless-openclaw
 * (packages/container/src/s3-sync.ts), with two changes:
 *   - the S3 client is injectable (`client`) for testability
 *   - both functions return the number of files transferred
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

/** Upload every file under `localPath` to `prefix/`. Returns file count. */
export async function backupToS3(params: SyncParams): Promise<number> {
  const client = params.client ?? new S3Client({ region: params.region });
  const { bucket, prefix, localPath } = params;

  if (!fs.existsSync(localPath)) return 0;
  let uploaded = 0;

  async function uploadDir(dirPath: string, s3Prefix: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await uploadDir(fullPath, `${s3Prefix}/${entry.name}`);
      } else if (entry.isFile()) {
        const fileBody = fs.readFileSync(fullPath);
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: `${s3Prefix}/${entry.name}`, Body: fileBody }),
        );
        uploaded += 1;
      }
    }
  }

  await uploadDir(localPath, prefix);
  return uploaded;
}
