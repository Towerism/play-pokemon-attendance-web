#!/usr/bin/env bash
# Container smoke test for the optional Litestream backups (ADR-0002, ADR-0006).
#
#   test/docker/litestream.sh [image]   default image: play-pokemon-attendance:test
#
# Uses a file:// replica on a temp bind mount, so it needs no bucket or network.
# Checks: off by default, an empty replica is a normal first run, litestream and
# node run as PUID:PGID, the replica is written, a graceful stop within Docker's
# 10 s timeout keeps the last write, an empty /data is restored from the replica,
# an existing database is never restored over, secrets never reach the replica,
# and a broken replica URL or an unwritable replica directory stops the container.
set -euo pipefail

IMAGE="${1:-play-pokemon-attendance:test}"
PUID=1234
PGID=2345
NAME="ppa-litestream-$$"
DATA="$(mktemp -d)"
DATA2="$(mktemp -d)"
REPLICA="$(mktemp -d)"
DATA3="$(mktemp -d)"
UNWRITABLE="$(mktemp -d)"   # mode 0700, owned by the runner: PUID can't use it
URL="file:///replica"
FAILURES=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files are owned by PUID; remove them from inside a container.
  for d in "$DATA" "$DATA2" "$DATA3" "$REPLICA" "$UNWRITABLE"; do
    docker run --rm -v "$d:/x" --entrypoint sh "$IMAGE" -c 'rm -rf /x/* /x/.[!.]*' >/dev/null 2>&1 || true
    rmdir "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

healthy() {
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}

# start <data dir> [extra docker run args…]
start() {
  local data="$1"; shift
  docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -v "$data:/data" -v "$REPLICA:/replica" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    healthy && return 0
    sleep 1
  done
  echo "container never became healthy:"; docker logs "$NAME"; return 1
}

stop_and_remove() { docker stop "$NAME" >/dev/null; docker rm "$NAME" >/dev/null; }
in_container() { docker exec "$NAME" "$@"; }
logs() { docker logs "$NAME" 2>&1; }

# Owner (uid:gid) of the first process whose executable (argv[0] basename) is $1.
# Not /proc/<pid>/comm: Node 24 renames its main thread "MainThread".
process_owner() {
  in_container sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$" | sort -n); do
    exe=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null | head -n 1)
    [ "${exe##*/}" = "'"$1"'" ] && { stat -c "%u:%g" /proc/$p; break; }; done'
}

api() { # api <path> <json body> → exit 0 on HTTP 200
  in_container node -e "
    fetch('http://127.0.0.1:3000$1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify($2) })
    .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
}

# Like an Unraid share (nobody:users by default): the replica directory belongs to
# PUID:PGID. The entrypoint never chowns a replica path; it is the user's mount.
docker run --rm -v "$REPLICA:/replica" --entrypoint chown "$IMAGE" "$PUID:$PGID" /replica
in_replica() { docker run --rm -v "$REPLICA:/replica" --entrypoint "$1" "$IMAGE" "${@:2}"; }

echo "without LITESTREAM_REPLICA_URL"
start "$DATA"
check "no litestream process" test -z "$(process_owner litestream)"
check "no litestream metadata under /data" bash -c "! docker exec '$NAME' sh -c 'ls -A /data' | grep -q litestream"
check "log says nothing about litestream" bash -c "! docker logs '$NAME' 2>&1 | grep -qi litestream"
docker rm -f "$NAME" >/dev/null
docker run --rm -v "$DATA:/x" --entrypoint sh "$IMAGE" -c 'rm -rf /x/* /x/.[!.]*'

echo "first boot with an empty replica"
start "$DATA" -e LITESTREAM_REPLICA_URL="$URL"
check "log names the replica target" grep -qF "[entrypoint] litestream: replicating /data/app.db to $URL" <(logs)
check "empty replica means a normal first run" grep -qF "no replica found, starting with an empty database" <(logs)
check "setup code printed" grep -Eq 'setup code: [A-Z2-9]{4}-[A-Z2-9]{4}' <(logs)
check "litestream runs as PUID:PGID" test "$(process_owner litestream)" = "$PUID:$PGID"
check "node runs as PUID:PGID" test "$(process_owner node)" = "$PUID:$PGID"
check "litestream metadata owned by PUID:PGID" \
  test "$(in_container stat -c '%u:%g' /data/.app.db-litestream)" = "$PUID:$PGID"

SETUP_CODE="$(logs | grep -Eo 'setup code: [A-Z2-9]{4}-[A-Z2-9]{4}' | tail -1 | cut -d' ' -f3)"
check "first-run setup creates the organizer" \
  api /api/auth/setup "{ setupCode: '$SETUP_CODE', username: 'organizer', password: 'correct horse' }"

# Stop right after the write: the final sync on shutdown must carry it.
started=$(date +%s)
docker stop "$NAME" >/dev/null
check "stops within the 10 s timeout" test $(( $(date +%s) - started )) -lt 10
check "exit code is clean (not SIGKILL)" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 137
docker rm "$NAME" >/dev/null
check "replica was written" test -n "$(in_replica ls -A /replica)"
SESSION_PASSWORD="$(docker run --rm -v "$DATA:/data" --entrypoint cat "$IMAGE" /data/secrets/session-password)"
check "no secret bytes in the replica" \
  bash -c "! docker run --rm -v '$REPLICA:/replica' --entrypoint grep '$IMAGE' -rqF '$SESSION_PASSWORD' /replica"

echo "new box: empty /data, same replica"
start "$DATA2" -e LITESTREAM_REPLICA_URL="$URL"
check "restored from the replica before starting" grep -qF "litestream: restored /data/app.db from replica" <(logs)
check "no setup code (the account came back)" bash -c "! docker logs '$NAME' 2>&1 | grep -q 'setup code'"
check "the restored organizer can log in" \
  api /api/auth/login "{ username: 'organizer', password: 'correct horse' }"
stop_and_remove

echo "restart with an existing database"
start "$DATA2" -e LITESTREAM_REPLICA_URL="$URL"
check "does not restore over an existing database" bash -c "! docker logs '$NAME' 2>&1 | grep -q 'restored'"
stop_and_remove

echo "broken replica URL"
docker run -d --name "$NAME" -e LITESTREAM_REPLICA_URL=bogus://nowhere -v "$DATA2:/data" "$IMAGE" >/dev/null
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break
  sleep 1
done
check "container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "exit code is non-zero" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 0
check "litestream's error is in the log" grep -q 'unknown replica type' <(logs)
docker rm "$NAME" >/dev/null

# With an empty /data the startup restore hits the permission error and stops
# the container. (With an existing database litestream starts, logs sync errors
# and keeps the app serving, like an unreachable bucket.)
echo "empty /data, replica directory PUID:PGID cannot read"
docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -e LITESTREAM_REPLICA_URL="$URL" \
  -v "$DATA3:/data" -v "$UNWRITABLE:/replica" "$IMAGE" >/dev/null
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break
  sleep 1
done
check "container exits on its own" test "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false
check "exit code is non-zero" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 0
check "the permission error is in the log" grep -q 'permission denied' <(logs)
docker rm "$NAME" >/dev/null

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"; exit 1
fi
echo "all checks passed"
