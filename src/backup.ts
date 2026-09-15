import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { createGzip } from "node:zlib";
import type { Bucket } from "./bucket";
import type { Env } from "./env";

const SYSTEM_SCHEMAS = new Set(["mysql", "sys", "performance_schema", "information_schema"]);

/**
 * mysqldump flags. Tuned for the official MySQL client (8.x / 9.x) talking to
 * a Railway MySQL service:
 *  - --single-transaction / --quick: consistent InnoDB snapshot, streamed rows
 *  - --routines/--triggers/--events: include programmable objects
 *  - --set-gtid-purged=OFF / --column-statistics=0: keep the dump restorable on any server
 *  - --get-server-public-key: caching_sha2_password works even without TLS
 */
const DUMP_FLAGS = [
  "--single-transaction",
  "--quick",
  "--routines",
  "--triggers",
  "--events",
  "--hex-blob",
  "--no-tablespaces",
  "--default-character-set=utf8mb4",
  "--set-gtid-purged=OFF",
  "--column-statistics=0",
  "--get-server-public-key",
];

const STDERR_LIMIT = 64 * 1024;
const TAIL_LIMIT = 256;
const DUMP_TRAILER = /-- Dump completed/;

export interface BackupResult {
  key: string;
  databases: string[];
  rawBytes: number;
  compressedBytes: number;
  seconds: number;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "BackupError";
  }
}

/** Counts the bytes flowing through it. */
class ByteCounter extends Transform {
  bytes = 0;
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** Splits MYSQLDUMP_BIN-style values such as "mysqldump" or "node fake.js" into command + args. */
const parseCommand = (value: string): { cmd: string; args: string[] } => {
  const [cmd, ...args] = value.trim().split(/\s+/);
  return { cmd, args };
};

/** Environment handed to the MySQL client processes: everything except our own secrets. */
const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BUCKET_") || k === "BACKUP_DATABASE_PASSWORD") continue;
    out[k] = v;
  }
  return out;
};

const quoteOption = (value: string): string => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
};

/**
 * Writes a [client] option file so the password never appears on a command
 * line or in process listings. Returns the temp directory and the file path.
 */
async function writeOptionFile(env: Env): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "railway-mysql-backup-"));
  const file = join(dir, "client.cnf");
  const content = [
    "[client]",
    `host=${quoteOption(env.BACKUP_DATABASE_HOST)}`,
    `port=${env.BACKUP_DATABASE_PORT}`,
    `user=${quoteOption(env.BACKUP_DATABASE_USER)}`,
    `password=${quoteOption(env.BACKUP_DATABASE_PASSWORD)}`,
    "",
  ].join("\n");
  await writeFile(file, content, { mode: 0o600 });
  return { dir, file };
}

/** Runs a single statement with the mysql client and returns stdout. */
function mysqlQuery(env: Env, optionFile: string, sql: string): Promise<string> {
  const { cmd, args } = parseCommand(env.MYSQL_BIN);
  const fullArgs = [
    ...args,
    `--defaults-extra-file=${optionFile}`,
    "--batch",
    "--skip-column-names",
    "--connect-timeout=10",
    "--get-server-public-key",
    "-e",
    sql,
  ];
  if (env.DEBUG) console.log(`[debug] ${cmd} ${fullArgs.join(" ")}`);

  return new Promise<string>((resolve, reject) => {
    execFile(cmd, fullArgs, { env: childEnv(), maxBuffer: 1024 * 1024 }, (error, out, err) => {
      if (error) {
        reject(new BackupError(err.trim() || error.message, err));
        return;
      }
      resolve(out);
    });
  });
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BackupError("Backup timed out while waiting for the database."));
      },
      { once: true },
    );
  });

/**
 * Waits until the database accepts connections. Railway puts idle services to
 * sleep; the first private-network connection wakes them but is refused, so
 * retry a few times before giving up.
 */
async function waitForDatabase(env: Env, optionFile: string, signal: AbortSignal): Promise<void> {
  const attempts = Math.max(1, env.BACKUP_CONNECT_RETRIES);
  for (let attempt = 1; ; attempt++) {
    try {
      await mysqlQuery(env, optionFile, "SELECT 1");
      if (attempt > 1) console.log(`Database reachable after ${attempt} attempts.`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) {
        throw new BackupError(`Database unreachable after ${attempts} attempts: ${message}`, message);
      }
      console.log(
        `Database not reachable yet (attempt ${attempt}/${attempts}): ${message}. ` +
          `Retrying in ${env.BACKUP_CONNECT_DELAY_SECONDS}s ...`,
      );
      await sleep(env.BACKUP_CONNECT_DELAY_SECONDS * 1000, signal);
    }
  }
}

/** Lists every non-system schema using the mysql client (no shell, no grep). */
async function listUserDatabases(env: Env, optionFile: string): Promise<string[]> {
  const { cmd, args } = parseCommand(env.MYSQL_BIN);
  const fullArgs = [
    ...args,
    `--defaults-extra-file=${optionFile}`,
    "--batch",
    "--skip-column-names",
    "--get-server-public-key",
    "-e",
    "SHOW DATABASES",
  ];
  if (env.DEBUG) console.log(`[debug] ${cmd} ${fullArgs.join(" ")}`);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(cmd, fullArgs, { env: childEnv(), maxBuffer: 1024 * 1024 }, (error, out, err) => {
      if (error) {
        reject(new BackupError(`Listing databases failed: ${err.trim() || error.message}`, err));
        return;
      }
      resolve(out);
    });
  });

  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SYSTEM_SCHEMAS.has(s));
}

const timestamp = (date: Date): string => date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");

export const objectKey = (env: Env, date: Date): string => {
  const label = env.BACKUP_DATABASE_NAME || "all";
  return `${env.BACKUP_SOURCE_NAME}/${label}-${timestamp(date)}.sql.gz`;
};

/**
 * Dumps the database(s) with mysqldump, gzips the stream and uploads it to
 * the bucket, all without touching the local disk. The upload only completes
 * when mysqldump exited 0 and produced a plausible, complete dump; otherwise
 * the multipart upload is aborted and a BackupError carrying stderr is thrown.
 */
export async function runBackup(env: Env, bucket: Bucket, signal: AbortSignal): Promise<BackupResult> {
  const started = Date.now();
  const { dir, file: optionFile } = await writeOptionFile(env);

  try {
    await waitForDatabase(env, optionFile, signal);

    const databases = env.BACKUP_DATABASE_NAME
      ? [env.BACKUP_DATABASE_NAME]
      : await listUserDatabases(env, optionFile);
    if (databases.length === 0) {
      throw new BackupError("No user databases found to back up.");
    }

    const key = objectKey(env, new Date());
    const { cmd, args } = parseCommand(env.MYSQLDUMP_BIN);
    const dumpArgs = [...args, `--defaults-extra-file=${optionFile}`, ...DUMP_FLAGS, "--databases", ...databases];
    if (env.DEBUG) console.log(`[debug] ${cmd} ${dumpArgs.join(" ")}`);
    console.log(`Dumping ${databases.join(", ")} from ${env.BACKUP_DATABASE_HOST}:${env.BACKUP_DATABASE_PORT} ...`);

    const child = spawn(cmd, dumpArgs, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    let rawBytes = 0;
    let tail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      rawBytes += chunk.length;
      tail = (tail + chunk.toString("latin1")).slice(-TAIL_LIMIT);
    });

    const gzip = createGzip({ level: 6 });
    const counter = new ByteCounter();
    // Do not let gzip finish until we have seen mysqldump's exit status.
    child.stdout.pipe(gzip, { end: false });
    gzip.pipe(counter);

    const abort = new AbortController();
    let failure: BackupError | undefined;
    // Failures are reported through `failure`; swallow the stream error events
    // so destroying the pipeline does not surface as an uncaught exception.
    const noteStreamError = (error: Error): void => {
      if (!failure) failure = new BackupError(`Stream error: ${error.message}`, stderr);
    };
    gzip.on("error", noteStreamError);
    counter.on("error", noteStreamError);
    const killChild = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const fail = (error: BackupError): void => {
      if (failure) return;
      failure = error;
      gzip.destroy(error);
      counter.destroy(error);
      abort.abort(error);
      killChild();
    };

    const onTimeout = (): void =>
      fail(new BackupError(`Backup timed out after ${env.BACKUP_TIMEOUT_SECONDS}s`, stderr));
    if (signal.aborted) onTimeout();
    signal.addEventListener("abort", onTimeout, { once: true });

    child.on("error", (error) => fail(new BackupError(`Could not start ${cmd}: ${error.message}`, stderr)));
    child.on("close", (code, sig) => {
      if (failure) return;
      if (code !== 0) {
        fail(new BackupError(`mysqldump exited with ${code ?? sig}: ${stderr.trim() || "(no stderr)"}`, stderr));
        return;
      }
      if (rawBytes < env.BACKUP_MIN_BYTES) {
        fail(
          new BackupError(
            `Dump is only ${rawBytes} bytes (below BACKUP_MIN_BYTES=${env.BACKUP_MIN_BYTES}); refusing to upload.`,
            stderr,
          ),
        );
        return;
      }
      if (!DUMP_TRAILER.test(tail)) {
        fail(new BackupError("Dump does not end with the mysqldump completion trailer; it looks truncated.", stderr));
        return;
      }
      if (stderr.trim()) console.warn(`mysqldump warnings:\n${stderr.trim()}`);
      gzip.end();
    });

    console.log(`Uploading to ${bucket.name}/${key} ...`);
    try {
      await bucket.uploadStream(key, counter, abort);
    } catch (error) {
      // Prefer the dump-side error (it carries stderr) over the upload abort error.
      if (failure) throw failure;
      killChild();
      throw new BackupError(`Upload failed: ${(error as Error).message}`, stderr);
    } finally {
      signal.removeEventListener("abort", onTimeout);
    }
    if (failure) throw failure;

    const stored = await bucket.size(key);
    if (stored !== counter.bytes) {
      throw new BackupError(`Uploaded object size ${stored} does not match local size ${counter.bytes}.`);
    }

    return {
      key,
      databases,
      rawBytes,
      compressedBytes: counter.bytes,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
