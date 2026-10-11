# syntax=docker/dockerfile:1.7
#
# One image definition for the project, one stage per role:
#   app     (default) the Nuxt server behind docker/entrypoint.sh (ADR-0006),
#           with an optional Litestream supervisor (ADR-0002)
#   spikes  M0 spike tooling with an hourly S2 token refresh (supercronic)

ARG NODE_IMAGE=node:22.23.3-alpine3.23
ARG NODE_SLIM_IMAGE=node:22.23.3-slim
ARG PNPM_VERSION=10.18.2

# ---------------------------------------------------------------- spikes ----

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
WORKDIR /app
# corepack in this Node line ships stale npm signing keys, so install pnpm directly.
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
COPY package.json pnpm-lock.yaml ./
# No lifecycle scripts: spikes need neither `nuxt prepare` nor native SQLite.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.spikes.json ./tsconfig.json
COPY shared ./shared
COPY server ./server

FROM base AS spikes
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.49
ARG SUPERCRONIC_SHA256_amd64=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1
ARG SUPERCRONIC_SHA256_arm64=02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sha="${SUPERCRONIC_SHA256_amd64}" ;; \
      arm64) sha="${SUPERCRONIC_SHA256_arm64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -qO /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH:-amd64}"; \
    echo "${sha}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod +x /usr/local/bin/supercronic
COPY spikes ./spikes
# The volume mount point must exist and be owned by `node` so a fresh named
# volume inherits that ownership. Tokens never live in the image itself.
RUN rm -rf spikes/.secrets && mkdir -p /data/spike-secrets && chown node:node /data/spike-secrets && chmod 700 /data/spike-secrets
ENV SPIKE_SECRETS_DIR=/data/spike-secrets
VOLUME ["/data/spike-secrets"]
USER node
CMD ["supercronic", "-passthrough-logs", "/app/spikes/crontab"]

# ------------------------------------------------------------------- app ----

FROM ${NODE_SLIM_IMAGE} AS app-build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
COPY package.json pnpm-lock.yaml ./
# `postinstall` (nuxt prepare) needs the sources; `nuxt build` prepares anyway.
# better-sqlite3 ships prebuilt binaries, so no compiler is needed.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build

# Optional off-box backups (ADR-0002). The release binary is static, so it is
# fetched and verified here and only the binary is copied into the runtime.
FROM ${NODE_IMAGE} AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256_amd64=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG LITESTREAM_SHA256_arm64=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sha="${LITESTREAM_SHA256_amd64}" ;; \
      arm64) arch=arm64;  sha="${LITESTREAM_SHA256_arm64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tarball="litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz"; \
    wget -qO "/tmp/${tarball}" \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${tarball}"; \
    echo "${sha}  /tmp/${tarball}" | sha256sum -c -; \
    tar -xzf "/tmp/${tarball}" -C /usr/local/bin litestream; \
    /usr/local/bin/litestream version

FROM ${NODE_SLIM_IMAGE} AS app
# gosu: drop root after fixing /data ownership. tini: PID 1 that forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tini \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true
WORKDIR /app
COPY --from=app-build /app/.output ./.output
COPY --from=app-build /app/server/db/migrations ./server/db/migrations
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/litestream.yml /etc/litestream.yml
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    NUXT_DATABASE_PATH=/data/app.db \
    NUXT_MIGRATIONS_DIR=/app/server/db/migrations \
    NITRO_SHUTDOWN_TIMEOUT=8000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", ".output/launcher.mjs"]
