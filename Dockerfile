# syntax=docker/dockerfile:1.7
#
# One image definition for the project, one stage per role:
#   spikes  M0 spike tooling with an hourly S2 token refresh (supercronic)
#   app     (M1) the Nuxt server, `node .output/server/index.mjs`

ARG NODE_IMAGE=node:22.23.3-alpine3.23

FROM ${NODE_IMAGE} AS base
WORKDIR /app
# corepack in this Node line ships stale npm signing keys, so install pnpm directly.
RUN npm install -g pnpm@10.18.2 && npm cache clean --force
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
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
