#!/bin/sh
# Container entrypoint, shipped by @towerism/selfhost-kit (ADR-0004). An app's Dockerfile copies it
# out of node_modules with `selfhost-kit docker-assets <dir>`. Its env names, log lines and exit
# codes are public API (ADR-0005): change them only in a major release.
#
# Started as root: fix ownership of /data for PUID:PGID (Unraid's nobody:users
# by default), apply UMASK, then drop privileges with gosu. Started as a
# non-root user (docker run --user …): just run.
#
# Secrets are bootstrapped by the Node launcher, after the drop, so generated
# files are owned by PUID:PGID.
#
# Optional Litestream: with LITESTREAM_REPLICA_URL set, restore the
# database from the replica when it is missing, then run the command as the
# child of `litestream replicate`. A failed restore or a litestream that cannot
# start stops the container: running without the backups that were asked for
# is worse than not running.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
DATA_DIR="${DATA_DIR:-/data}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"

umask "$UMASK"

case "$PUID$PGID" in
  *[!0-9]*) echo "[entrypoint] PUID and PGID must be numeric (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac

AS_APP_USER=""
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only touch what is wrong: appdata can be large and on slow array disks. -h: re-own a symlink itself,
  # never its target (a link the app left could point at any file the container can see). This guards the
  # last path component; it assumes nothing else writes to /data while the container starts.
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +
  AS_APP_USER="gosu $PUID:$PGID"
fi

# Single-quotes each argument so `litestream replicate -exec` splits them back exactly.
shell_quote() {
  quoted=""
  for arg in "$@"; do
    quoted="$quoted${quoted:+ }'$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"
  done
  printf '%s' "$quoted"
}

# scheme://host/path only: no userinfo, no query string (it can carry endpoints or keys).
redact_url() {
  printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\1#; s#[?\#].*$##'
}

replica_url="$(printf '%s' "${LITESTREAM_REPLICA_URL:-}" | tr -d '[:space:]')"
if [ -z "$replica_url" ]; then
  if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}${LITESTREAM_SECRET_ACCESS_KEY:-}" ]; then
    echo "[entrypoint] litestream: LITESTREAM_ACCESS_KEY_ID/SECRET set but LITESTREAM_REPLICA_URL is empty; backups are off" >&2
  fi
  exec $AS_APP_USER "$@"
fi

db_path="${NUXT_DATABASE_PATH:-/data/app.db}"
export LITESTREAM_REPLICA_URL="$replica_url" NUXT_DATABASE_PATH="$db_path"
echo "[entrypoint] litestream: replicating $db_path to $(redact_url "$replica_url")"

if [ ! -e "$db_path" ]; then
  $AS_APP_USER litestream restore -config "$LITESTREAM_CONFIG" -if-db-not-exists -if-replica-exists "$db_path"
  if [ -e "$db_path" ]; then
    echo "[entrypoint] litestream: restored $db_path from replica"
  else
    echo "[entrypoint] litestream: no replica found, starting with an empty database"
  fi
fi

exec $AS_APP_USER litestream replicate -config "$LITESTREAM_CONFIG" -exec "$(shell_quote "$@")"
