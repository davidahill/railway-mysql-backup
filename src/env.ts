import { bool, envsafe, num, port, str } from "envsafe";

/**
 * Runtime configuration. On Railway every value is wired through variable
 * references in `.railway/railway.ts`; locally you can export them by hand.
 */
const raw = envsafe({
  // --- Railway bucket (object storage) ------------------------------------
  BUCKET_NAME: str({
    desc: "Bucket name as reported by the Railway bucket (reference ${{<bucket>.BUCKET}}).",
  }),
  BUCKET_ENDPOINT: str({
    desc: "S3-compatible endpoint of the Railway bucket (reference ${{<bucket>.ENDPOINT}}).",
  }),
  BUCKET_ACCESS_KEY_ID: str({
    desc: "Bucket access key id (reference ${{<bucket>.ACCESS_KEY_ID}}).",
  }),
  BUCKET_SECRET_ACCESS_KEY: str({
    desc: "Bucket secret access key (reference ${{<bucket>.SECRET_ACCESS_KEY}}).",
  }),
  BUCKET_REGION: str({
    desc: "Bucket region for request signing. Railway buckets report `auto`.",
    default: "auto",
    allowEmpty: true,
  }),

  // --- Source database -----------------------------------------------------
  BACKUP_SOURCE_NAME: str({
    desc:
      "Folder inside the bucket, normally the Railway MySQL service name. " +
      "Leave empty to derive it from the database host (e.g. mysql-a1b2.railway.internal -> mysql-a1b2).",
    default: "",
    allowEmpty: true,
  }),
  BACKUP_DATABASE_HOST: str({ desc: "MySQL host (reference ${{<mysql>.MYSQLHOST}})." }),
  BACKUP_DATABASE_PORT: port({ desc: "MySQL port (reference ${{<mysql>.MYSQLPORT}}).", default: 3306 }),
  BACKUP_DATABASE_USER: str({ desc: "MySQL user (reference ${{<mysql>.MYSQLUSER}})." }),
  BACKUP_DATABASE_PASSWORD: str({ desc: "MySQL password (reference ${{<mysql>.MYSQLPASSWORD}})." }),
  BACKUP_DATABASE_NAME: str({
    desc: "Schema to dump. Leave empty to dump every non-system schema on the server.",
    default: "",
    allowEmpty: true,
  }),

  // --- Behaviour -----------------------------------------------------------
  BACKUP_RETENTION_DAYS: num({
    desc: "Delete backups in this source's folder older than N days after a successful run. 0 disables pruning.",
    default: 30,
  }),
  BACKUP_MIN_BYTES: num({
    desc: "Fail the run if the uncompressed dump is smaller than this. Guards against empty dumps.",
    default: 1024,
  }),
  BACKUP_TIMEOUT_SECONDS: num({
    desc: "Abort the run (dump + upload) after this many seconds.",
    default: 3600,
  }),
  BACKUP_CONNECT_RETRIES: num({
    desc: "How many times to retry the initial connection. Lets a sleeping Railway database wake up.",
    default: 10,
  }),
  BACKUP_CONNECT_DELAY_SECONDS: num({
    desc: "Seconds to wait between connection attempts.",
    default: 15,
  }),
  MYSQLDUMP_BIN: str({
    desc: "mysqldump executable. May include leading arguments (e.g. `node fake.js`) for test doubles.",
    default: "mysqldump",
  }),
  MYSQL_BIN: str({
    desc: "mysql client executable, used to list schemas when BACKUP_DATABASE_NAME is empty.",
    default: "mysql",
  }),
  DEBUG: bool({ desc: "Verbose logging (commands, upload progress).", default: false }),
});

const normalizeEndpoint = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/** Folder name: the configured source name, or the first DNS label of the database host. */
const sourceName = (configured: string, host: string): string => {
  const explicit = configured.trim().replace(/^\/+|\/+$/g, "");
  if (explicit) return explicit;
  const derived = host
    .trim()
    .split(".")[0]
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!derived) {
    throw new Error("BACKUP_SOURCE_NAME is empty and cannot be derived from BACKUP_DATABASE_HOST.");
  }
  return derived;
};

export const env = {
  ...raw,
  BUCKET_ENDPOINT: normalizeEndpoint(raw.BUCKET_ENDPOINT),
  BACKUP_SOURCE_NAME: sourceName(raw.BACKUP_SOURCE_NAME, raw.BACKUP_DATABASE_HOST),
};

export type Env = typeof env;
