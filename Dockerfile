# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# ---- build -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Official MySQL client so mysqldump speaks caching_sha2_password to the
# MySQL 8.x/9.x server Railway runs. Switch to `mysql-8.4-lts` for 8.x servers.
ARG MYSQL_APT_COMPONENT=mysql-9.7-lts
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://repo.mysql.com/RPM-GPG-KEY-mysql-2025 | gpg --dearmor -o /usr/share/keyrings/mysql.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/mysql.gpg] http://repo.mysql.com/apt/debian/ bookworm ${MYSQL_APT_COMPONENT}" \
      > /etc/apt/sources.list.d/mysql.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends mysql-community-client; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    mysqldump --version

LABEL org.opencontainers.image.source="https://github.com/davidahill/railway-mysql-backup" \
      org.opencontainers.image.description="Scheduled, verified backups of a Railway MySQL service into a Railway bucket" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
CMD ["node", "dist/index.js"]
