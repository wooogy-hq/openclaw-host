import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { restoreFromS3, backupToS3, type S3Like } from "../src/s3-sync.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s3sync-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function body(text: string) {
  return {
    transformToByteArray: async () => new TextEncoder().encode(text),
  };
}

describe("restoreFromS3", () => {
  it("downloads objects to localPath preserving relative structure and returns the count", async () => {
    const objects: Record<string, string> = {
      "workspaces/u1/AGENTS.md": "hello",
      "workspaces/u1/src/app.ts": "code",
    };
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof ListObjectsV2Command) {
          return { Contents: Object.keys(objects).map((Key) => ({ Key })), IsTruncated: false };
        }
        if (cmd instanceof GetObjectCommand) {
          return { Body: body(objects[(cmd.input as { Key: string }).Key]) };
        }
        throw new Error("unexpected command");
      },
    };

    const count = await restoreFromS3({
      bucket: "b",
      prefix: "workspaces/u1",
      localPath: tmp,
      client,
    });

    expect(count).toBe(2);
    expect(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(tmp, "src/app.ts"), "utf-8")).toBe("code");
  });

  it("skips directory-marker keys ending in slash", async () => {
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof ListObjectsV2Command) {
          return {
            Contents: [{ Key: "workspaces/u1/" }, { Key: "workspaces/u1/a.txt" }],
            IsTruncated: false,
          };
        }
        return { Body: body("x") };
      },
    };
    const count = await restoreFromS3({ bucket: "b", prefix: "workspaces/u1", localPath: tmp, client });
    expect(count).toBe(1);
    expect(fs.existsSync(path.join(tmp, "a.txt"))).toBe(true);
  });

  it("follows pagination via continuation tokens", async () => {
    let page = 0;
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof ListObjectsV2Command) {
          page += 1;
          if (page === 1) {
            return { Contents: [{ Key: "p/1.txt" }], IsTruncated: true, NextContinuationToken: "t" };
          }
          return { Contents: [{ Key: "p/2.txt" }], IsTruncated: false };
        }
        return { Body: body("x") };
      },
    };
    const count = await restoreFromS3({ bucket: "b", prefix: "p", localPath: tmp, client });
    expect(count).toBe(2);
    expect(page).toBe(2);
  });

  it("returns 0 and does not throw on S3 error (non-fatal first launch)", async () => {
    const client: S3Like = {
      send: async () => {
        throw new Error("AccessDenied");
      },
    };
    const count = await restoreFromS3({ bucket: "b", prefix: "p", localPath: tmp, client });
    expect(count).toBe(0);
  });
});

describe("backupToS3", () => {
  it("uploads all files recursively under the prefix and returns the count", async () => {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "a");
    fs.writeFileSync(path.join(tmp, "src/app.ts"), "b");

    const uploaded: string[] = [];
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof PutObjectCommand) {
          uploaded.push((cmd.input as { Key: string }).Key);
        }
        return {};
      },
    };

    const count = await backupToS3({ bucket: "b", prefix: "workspaces/u1", localPath: tmp, client });

    expect(count).toBe(2);
    expect(uploaded.sort()).toEqual(["workspaces/u1/AGENTS.md", "workspaces/u1/src/app.ts"]);
  });

  it("returns 0 when localPath does not exist", async () => {
    const client: S3Like = { send: async () => ({}) };
    const count = await backupToS3({
      bucket: "b",
      prefix: "p",
      localPath: path.join(tmp, "nope"),
      client,
    });
    expect(count).toBe(0);
  });

  it("skips excluded directories (node_modules, .git, ...)", async () => {
    fs.writeFileSync(path.join(tmp, "keep.ts"), "k");
    fs.mkdirSync(path.join(tmp, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules/dep/index.js"), "junk");
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".git/HEAD"), "ref");

    const uploaded: string[] = [];
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof PutObjectCommand) uploaded.push((cmd.input as { Key: string }).Key);
        return {};
      },
    };

    const count = await backupToS3({ bucket: "b", prefix: "p", localPath: tmp, client });
    expect(count).toBe(1);
    expect(uploaded).toEqual(["p/keep.ts"]);
  });

  it("skips nested git repos (clones/submodules) but keeps the root's own files", async () => {
    // Backup root is itself a git repo with loose core files...
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "core");
    fs.mkdirSync(path.join(tmp, "guides"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "guides/x.md"), "guide");
    // ...containing a cloned sub-repo (its own .git) that must NOT be uploaded.
    fs.mkdirSync(path.join(tmp, "some-repo/.git"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "some-repo/main.ts"), "clone source");

    const uploaded: string[] = [];
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof PutObjectCommand) uploaded.push((cmd.input as { Key: string }).Key);
        return {};
      },
    };

    const count = await backupToS3({ bucket: "b", prefix: "p", localPath: tmp, client });
    expect(count).toBe(2);
    expect(uploaded.sort()).toEqual(["p/AGENTS.md", "p/guides/x.md"]);
  });

  it("incremental: re-uploads only changed files when a manifest is given", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "a");
    fs.writeFileSync(path.join(tmp, "b.txt"), "b");
    // Manifest lives OUTSIDE the backed-up dir (as in prod: /state/... vs the
    // workspace/sessions targets), else the backup would re-upload it itself.
    const manifestPath = `${tmp}.manifest.json`;

    const uploaded: string[] = [];
    const client: S3Like = {
      send: async (cmd: unknown) => {
        if (cmd instanceof PutObjectCommand) uploaded.push((cmd.input as { Key: string }).Key);
        return {};
      },
    };

    // First run uploads both and writes the manifest.
    const first = await backupToS3({ bucket: "b", prefix: "p", localPath: tmp, client, manifestPath });
    expect(first).toBe(2);

    // Nothing changed → second run uploads nothing.
    uploaded.length = 0;
    const second = await backupToS3({ bucket: "b", prefix: "p", localPath: tmp, client, manifestPath });
    expect(second).toBe(0);
    expect(uploaded).toEqual([]);

    // Change one file (bump mtime + content) → only that one re-uploads.
    fs.writeFileSync(path.join(tmp, "a.txt"), "aa");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(tmp, "a.txt"), future, future);
    const third = await backupToS3({ bucket: "b", prefix: "p", localPath: tmp, client, manifestPath });
    expect(third).toBe(1);
    expect(uploaded).toEqual(["p/a.txt"]);
  });
});
