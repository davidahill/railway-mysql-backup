/**
 * Example Railway Infrastructure as Code for the MySQL backup job.
 *
 * Railway IaC describes a WHOLE environment ("omit means delete"), so do not apply
 * this file as-is against an existing project. Instead:
 *
 *   1. In the repository that owns your environment, run `railway config pull`
 *      to import what already exists.
 *   2. Copy the `backupJob` helper below into that file and call it once per
 *      MySQL service you want backed up.
 *   3. `railway config plan`, read it, then `railway config apply`.
 *
 * Prefer the one-click template if you only want the job in an existing project.
 */
import { bucket, defineRailway, github, mysql, project, ref, service, type ReferencableDatabaseNode } from "railway/iac";

/** Repository and branch Railway builds the job from (Dockerfile in the repo root). */
const BACKUP_REPO = "davidahill/railway-mysql-backup";
const BACKUP_BRANCH = "master";

/** Daily at 05:00 UTC. Railway's minimum cron interval is 5 minutes. */
const BACKUP_SCHEDULE = "0 5 * * *";

/** Delete backups older than this many days after each successful run. */
const BACKUP_RETENTION_DAYS = "30";

/**
 * One cron service per MySQL database. The service is named `<db>-backup` and
 * writes to the folder `<db>/` inside the bucket; the database service's own
 * name is the single source of truth for both.
 */
export const backupJob = (db: ReferencableDatabaseNode<"mysql">, backups: ReturnType<typeof bucket>) =>
  service(`${db.name}-backup`, {
    source: github(BACKUP_REPO, { branch: BACKUP_BRANCH }),
    deploy: {
      cronSchedule: BACKUP_SCHEDULE,
      restartPolicyType: "NEVER",
    },
    env: {
      // Folder inside the bucket = the database service's name.
      BACKUP_SOURCE_NAME: db.env.RAILWAY_SERVICE_NAME,

      // Connection details, referenced from the database service (private network).
      BACKUP_DATABASE_HOST: db.env.MYSQLHOST,
      BACKUP_DATABASE_PORT: db.env.MYSQLPORT,
      BACKUP_DATABASE_USER: db.env.MYSQLUSER,
      BACKUP_DATABASE_PASSWORD: db.env.MYSQLPASSWORD,
      BACKUP_DATABASE_NAME: db.env.MYSQL_DATABASE,

      // Bucket credentials, referenced from the bucket.
      BUCKET_NAME: ref(backups, "BUCKET"),
      BUCKET_ENDPOINT: ref(backups, "ENDPOINT"),
      BUCKET_ACCESS_KEY_ID: ref(backups, "ACCESS_KEY_ID"),
      BUCKET_SECRET_ACCESS_KEY: ref(backups, "SECRET_ACCESS_KEY"),
      BUCKET_REGION: ref(backups, "REGION"),

      BACKUP_RETENTION_DAYS,
    },
  });

// Minimal, self-contained example: a database, a bucket, and one backup job.
export default defineRailway(() => {
  const db = mysql("MySQL");
  const backups = bucket("backups", { region: "sjc" });

  return project("my-project", {
    resources: [db, backups, backupJob(db, backups)],
  });
});
