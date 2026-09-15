import type { Bucket } from "./bucket";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes backups under `<sourceName>/` that are older than `retentionDays`.
 * Never touches `keepKey` (the backup that was just written) and only
 * considers `*.sql.gz` objects, so unrelated files in the folder are safe.
 * Returns the number of objects deleted.
 */
export async function pruneOldBackups(
  bucket: Bucket,
  sourceName: string,
  keepKey: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }

  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const objects = await bucket.list(`${sourceName}/`);
  const expired = objects
    .filter((o) => o.key !== keepKey)
    .filter((o) => o.key.endsWith(".sql.gz"))
    .filter((o) => o.lastModified.getTime() < cutoff)
    .map((o) => o.key);

  if (expired.length === 0) {
    return 0;
  }

  return bucket.deleteMany(expired);
}
