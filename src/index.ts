import { runBackup, BackupError } from "./backup";
import { Bucket } from "./bucket";
import { env } from "./env";
import { pruneOldBackups } from "./retention";

/**
 * Entry point for a Railway cron service: perform one backup, then exit.
 * Exit codes: 0 success, 1 backup failed, 3 unexpected error.
 */
const exit = (code: number): void => {
  process.exitCode = code;
  // Give stdout a moment to flush so Railway captures the last log lines.
  setTimeout(() => process.exit(code), 500).unref();
};

process.on("unhandledRejection", (reason) => {
  console.error("FATAL unhandled rejection:", reason);
  exit(3);
});
process.on("uncaughtException", (error) => {
  console.error("FATAL uncaught exception:", error);
  exit(3);
});

const main = async (): Promise<void> => {
  console.log(
    `Backup starting: source=${env.BACKUP_SOURCE_NAME} database=${env.BACKUP_DATABASE_NAME || "<all>"} ` +
      `host=${env.BACKUP_DATABASE_HOST}:${env.BACKUP_DATABASE_PORT} bucket=${env.BUCKET_NAME}`,
  );

  const bucket = new Bucket({
    name: env.BUCKET_NAME,
    endpoint: env.BUCKET_ENDPOINT,
    region: env.BUCKET_REGION,
    accessKeyId: env.BUCKET_ACCESS_KEY_ID,
    secretAccessKey: env.BUCKET_SECRET_ACCESS_KEY,
    debug: env.DEBUG,
  });

  try {
    const result = await runBackup(env, bucket, AbortSignal.timeout(env.BACKUP_TIMEOUT_SECONDS * 1000));
    console.log(
      `Backup OK: key=${result.key} databases=${result.databases.join(",")} ` +
        `raw=${result.rawBytes}B gzip=${result.compressedBytes}B verified=size-match time=${result.seconds.toFixed(1)}s`,
    );

    if (env.BACKUP_RETENTION_DAYS > 0) {
      try {
        const removed = await pruneOldBackups(bucket, env.BACKUP_SOURCE_NAME, result.key, env.BACKUP_RETENTION_DAYS);
        console.log(`Retention: removed ${removed} backup(s) older than ${env.BACKUP_RETENTION_DAYS} days.`);
      } catch (error) {
        console.warn(`Retention skipped: ${(error as Error).message}`);
      }
    }
  } finally {
    bucket.destroy();
  }
};

main()
  .then(() => exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`BACKUP FAILED: ${message}`);
    if (error instanceof BackupError && error.stderr.trim()) {
      console.error(`--- mysqldump stderr ---\n${error.stderr.trim()}`);
    }
    exit(1);
  });
