import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

/**
 * Thin wrapper around a Railway bucket. Railway buckets speak the S3 protocol,
 * so this is the only module that touches the S3 client library.
 */
export interface BucketConfig {
  name: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  debug?: boolean;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

const PART_SIZE = 16 * 1024 * 1024; // 16 MiB parts => ~48 MiB peak memory with queueSize 2
const DELETE_BATCH = 1000;

export class Bucket {
  private readonly client: S3Client;

  constructor(private readonly cfg: BucketConfig) {
    this.client = new S3Client({
      region: cfg.region || "auto",
      endpoint: cfg.endpoint,
      // Railway buckets use virtual-hosted style URLs (<bucket>.<endpoint host>).
      forcePathStyle: false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      // Newer SDKs default to CRC32 trailers / aws-chunked encoding which many
      // S3-compatible stores reject. Only compute checksums when the API requires one.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 5,
    });
  }

  get name(): string {
    return this.cfg.name;
  }

  /**
   * Streams `body` into `key` as a multipart upload. If `abortController` is
   * aborted (or the stream errors) the multipart upload is aborted server-side
   * so no partial object is left behind.
   */
  async uploadStream(
    key: string,
    body: Readable,
    abortController: AbortController,
    contentType = "application/gzip",
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      abortController,
      partSize: PART_SIZE,
      queueSize: 2,
      leavePartsOnError: false,
      params: { Bucket: this.cfg.name, Key: key, Body: body, ContentType: contentType },
    });

    if (this.cfg.debug) {
      upload.on("httpUploadProgress", (p) => {
        console.log(`[bucket] part ${p.part ?? "?"} sent, ${p.loaded ?? 0} bytes so far`);
      });
    }

    await upload.done();
  }

  /** Size in bytes of a stored object, or -1 if the store did not report one. */
  async size(key: string): Promise<number> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.name, Key: key }));
    return res.ContentLength ?? -1;
  }

  /** Lists every object under `prefix` (all pages). */
  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.name, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key && o.LastModified) {
          objects.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }

  /** Deletes the given keys in batches. Returns the number of keys deleted. */
  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.cfg.name,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (res.Errors && res.Errors.length > 0) {
        const first = res.Errors[0];
        throw new Error(
          `Failed to delete ${res.Errors.length} object(s); first: ${first.Key} ${first.Code} ${first.Message}`,
        );
      }
      deleted += batch.length;
    }
    return deleted;
  }

  destroy(): void {
    this.client.destroy();
  }
}
