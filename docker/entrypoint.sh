#!/bin/sh
# Container entrypoint (ADR-0006).
#
# Started as root: fix ownership of /data for PUID:PGID (Unraid's nobody:users
# by default), apply UMASK, then drop privileges with gosu. Started as a
# non-root user (docker run --user …): just run.
#
# Secrets are bootstrapped by the Node launcher, after the drop, so generated
# files are owned by PUID:PGID.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
DATA_DIR="${DATA_DIR:-/data}"

umask "$UMASK"

case "$PUID$PGID" in
  *[!0-9]*) echo "[entrypoint] PUID and PGID must be numeric (got PUID=$PUID PGID=$PGID)" >&2; exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only touch what is wrong: appdata can be large and on slow array disks.
  find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
