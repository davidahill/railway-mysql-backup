# Deploy and Host MySQL Bucket Backup on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/railway-mysql-backup-into-bucket)

MySQL Bucket Backup is a scheduled job that dumps a Railway MySQL service straight into a
Railway bucket. It streams `mysqldump` through gzip with no temp files, refuses to store an
empty or truncated dump, verifies the stored size, files each backup under a folder named
after the database, and prunes old copies. Nothing leaves Railway.

## About Hosting MySQL Bucket Backup

The job runs as a Railway cron service next to your database. On each run it wakes the
database if it is sleeping, connects over the private network, and pipes the dump into your
bucket as a multipart upload. A run only succeeds when `mysqldump` exits cleanly, the dump
ends with MySQL's completion trailer, and the object in the bucket matches the bytes sent.
Anything else aborts the upload, exits non-zero, and shows up as a failed deployment with
`mysqldump`'s error in the logs. There is no always-on process and no third-party cloud
account; the bucket's credentials are wired in through variable references.

## Common Use Cases

- Nightly off-database copies of a production MySQL service, kept for a rolling 30 days.
- Point-in-time snapshots before a migration or a risky deploy.
- Backing up several MySQL services in one project, each into its own folder.
- Restorable exports for local development or staging refreshes.
- Replacing an external S3 backup pipeline with storage inside the Railway project.

## Dependencies for MySQL Bucket Backup Hosting

- A Railway MySQL service (the official `mysql` image, 8.x or 9.x).
- A Railway bucket. The template creates one; the IaC example declares one.

### Deployment Dependencies

- Template: [railway.com/deploy/railway-mysql-backup-into-bucket](https://railway.com/deploy/railway-mysql-backup-into-bucket).
  One click creates the bucket and the job; you are prompted for the database host, user, and
  password (enter references such as `${{MySQL.MYSQLHOST}}`, using your database service's name).
  Prefer Infrastructure as Code (below) when the job should live in a versioned environment file.
- Source: [github.com/davidahill/railway-mysql-backup](https://github.com/davidahill/railway-mysql-backup)
- Railway docs: [Storage Buckets](https://docs.railway.com/storage-buckets),
  [Cron Jobs](https://docs.railway.com/cron-jobs),
  [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)

### Implementation Details

Backups land at:

```
<bucket>/<database service name>/<schema>-<UTC timestamp>.sql.gz
e.g.      MySQL/railway-2026-09-15T05-00-00Z.sql.gz
```

All variables are references, so nothing is typed by hand:

| Variable | Reference | Purpose |
| --- | --- | --- |
| `BUCKET_NAME` | `${{Bucket.BUCKET}}` | Bucket name |
| `BUCKET_ENDPOINT` | `${{Bucket.ENDPOINT}}` | S3-compatible endpoint |
| `BUCKET_ACCESS_KEY_ID` | `${{Bucket.ACCESS_KEY_ID}}` | Credentials |
| `BUCKET_SECRET_ACCESS_KEY` | `${{Bucket.SECRET_ACCESS_KEY}}` | Credentials |
| `BUCKET_REGION` | `${{Bucket.REGION}}` | Signing region (`auto`) |
| `BACKUP_SOURCE_NAME` | `${{MySQL.RAILWAY_SERVICE_NAME}}` | Folder inside the bucket; empty derives it from the host (`mysql-a1b2.railway.internal` → `mysql-a1b2`) |
| `BACKUP_DATABASE_HOST` | `${{MySQL.MYSQLHOST}}` | Private-network host |
| `BACKUP_DATABASE_PORT` | `${{MySQL.MYSQLPORT}}` | Port |
| `BACKUP_DATABASE_USER` | `${{MySQL.MYSQLUSER}}` | User |
| `BACKUP_DATABASE_PASSWORD` | `${{MySQL.MYSQLPASSWORD}}` | Passed via an option file, never on the command line |
| `BACKUP_DATABASE_NAME` | `${{MySQL.MYSQL_DATABASE}}` | Schema to dump; empty dumps every non-system schema |

Optional tuning: `BACKUP_RETENTION_DAYS` (default `30`, `0` disables pruning),
`BACKUP_MIN_BYTES` (default `1024`), `BACKUP_TIMEOUT_SECONDS` (default `3600`),
`BACKUP_CONNECT_RETRIES` and `BACKUP_CONNECT_DELAY_SECONDS` (default `10` x `15s`, lets a
sleeping database wake), `DEBUG`.

Replace `MySQL` and `Bucket` with your services' names. The cron schedule lives on the
service (default `0 5 * * *`, UTC); the container runs once and exits.

#### Prebuilt image

Every push to `master` publishes the Dockerfile to GitHub Container Registry as
`ghcr.io/davidahill/railway-mysql-backup` with tags `<version>`, `<major>.<minor>`, `<major>`,
`latest`, and `sha-<commit>`. Point a Railway service at the image instead of the repo when you
want to skip the build step or keep Railway off your GitHub account entirely.

#### Deploy with Infrastructure as Code

[`.railway/railway.ts`](.railway/railway.ts) is a self-contained example: a database, a bucket,
and a `backupJob(db, bucket)` helper. Railway IaC describes a whole environment, so import your
existing one first (`railway config pull` in the repo that owns it), copy the helper in, call it
once per MySQL service, then `railway config plan` and `railway config apply`.

#### Restore

```bash
# credentials: `railway bucket credentials` or the bucket's Credentials tab
aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp "s3://$AWS_S3_BUCKET_NAME/MySQL/railway-2026-09-15T05-00-00Z.sql.gz" .
gunzip -c railway-2026-09-15T05-00-00Z.sql.gz | mysql --host=... --port=... --user=... -p
```

Dumps use `--databases`, so they carry `CREATE DATABASE` and `USE` and restore into a fresh
server without extra flags.

#### Run locally

Node 22+ and the MySQL client tools (`mysqldump`, `mysql`) on `PATH`.

```bash
npm ci && npm run build
export BUCKET_NAME=... BUCKET_ENDPOINT=... BUCKET_ACCESS_KEY_ID=... BUCKET_SECRET_ACCESS_KEY=...
export BACKUP_SOURCE_NAME=MySQL BACKUP_DATABASE_HOST=... BACKUP_DATABASE_USER=... BACKUP_DATABASE_PASSWORD=... BACKUP_DATABASE_NAME=...
npm start
```

## Why Deploy MySQL Bucket Backup on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your
infrastructure so you don't have to deal with configuration, while allowing you to vertically
and horizontally scale it.

By deploying MySQL Bucket Backup on Railway, you are one step closer to supporting a complete
full-stack application with minimal burden. Host your servers, databases, AI agents, and more
on Railway.

---

Started from [Natuz/mysql-s3-backup](https://github.com/Natuz/mysql-s3-backup) (MIT).
