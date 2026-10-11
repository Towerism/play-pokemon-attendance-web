#!/usr/bin/env bash
# Restore drill for the `app` image: the backup and restore steps of
# docs/deploy/unraid.md, automated so CI proves they still work.
#
#   test/docker/restore-drill.sh [image]   default image: play-pokemon-attendance:test
#
# Full archive: set up the organizer, stop, tar the appdata folder (as Appdata
# Backup does), wipe it, extract the archive as root (files come back root-owned),
# start, and check the box came back: healthy, no setup code, the organizer can
# log in, secrets unchanged at 0600, files owned by PUID:PGID.
# Database without secrets/: the app still starts, generates new secrets at 0600,
# keeps the account (password hashes live in app.db) and asks for no setup code.
# A truncated archive must fail to extract, so a bad backup is caught by the drill.
set -euo pipefail

IMAGE="${1:-play-pokemon-attendance:test}"
PUID=1234
PGID=2345
NAME="ppa-restore-$$"
DATA="$(mktemp -d)"
BACKUP="$(mktemp -d)"
FAILURES=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files are owned by PUID or root; remove them from inside a container.
  for d in "$DATA" "$BACKUP"; do
    docker run --rm -v "$d:/x" --entrypoint sh "$IMAGE" -c 'rm -rf /x/* /x/.[!.]*' >/dev/null 2>&1 || true
    rmdir "$d" 2>/dev/null || true
  done
}
trap cleanup EXIT

pass() { echo "  ok   $*"; }
fail() {
  echo "  FAIL $*"; FAILURES=$((FAILURES + 1))
  docker logs "$NAME" 2>&1 | tail -20 | sed 's/^/       | /' || true
}
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

healthy() {
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}

start() {
  docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -e TZ=America/Chicago -v "$DATA:/data" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    healthy && return 0
    sleep 1
  done
  echo "container never became healthy:"; docker logs "$NAME" 2>&1 | tail -40; return 1
}

stop_and_remove() { docker stop "$NAME" >/dev/null; docker rm "$NAME" >/dev/null; }
in_container() { docker exec "$NAME" "$@"; }
logs() { docker logs "$NAME" 2>&1; }

# Runs a command as root in a throwaway container with appdata at /data and the
# backup share at /backup, the way the organizer works on the Unraid terminal.
as_root() { docker run --rm -v "$DATA:/data" -v "$BACKUP:/backup" --entrypoint "$1" "$IMAGE" "${@:2}"; }

api() { # api <path> <json body> → exit 0 on HTTP 200
  in_container node -e "
    fetch('http://127.0.0.1:3000$1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify($2) })
    .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
}
login() { api /api/auth/login "{ username: 'organizer', password: 'correct horse' }"; }
no_setup_code() { ! logs | grep -q 'setup code'; }
wipe() { as_root sh -c 'rm -rf /data/* /data/.[!.]*'; }
secret_sums() { as_root sh -c 'cd /data/secrets && sha256sum session-password token-vault.key'; }
mode_owner() { in_container stat -c '%a %u' "$1"; }

echo "live box"
start
SETUP_CODE="$(logs | grep -Eo 'setup code: [A-Z2-9]{4}-[A-Z2-9]{4}' | tail -1 | cut -d' ' -f3)"
check "first-run setup creates the organizer" \
  api /api/auth/setup "{ setupCode: '$SETUP_CODE', username: 'organizer', password: 'correct horse' }"
stop_and_remove
SUMS_BEFORE="$(secret_sums)"
OLD_SESSION_PASSWORD="$(as_root cat /data/secrets/session-password)"

echo "backup: stopped container, whole appdata folder, permissions kept"
check "archive written" as_root tar -C /data -cpf /backup/appdata.tar .
check "archive holds app.db and secrets/" \
  bash -c "docker run --rm -v '$BACKUP:/backup' --entrypoint tar '$IMAGE' -tf /backup/appdata.tar | grep -qx './secrets/token-vault.key'"

echo "restore the full archive onto an empty folder"
wipe
# --no-same-owner: extracted as root without keeping owners, the worst case;
# the entrypoint must hand everything back to PUID:PGID on boot.
check "archive extracts" as_root tar -C /data --no-same-owner -xpf /backup/appdata.tar
start
check "no setup code (the account came back)" no_setup_code
check "the organizer can log in" login
check "secrets are byte-identical to the backup" test "$(secret_sums)" = "$SUMS_BEFORE"
for f in session-password token-vault.key; do
  check "secrets/$f is 0600 and owned by PUID" test "$(mode_owner /data/secrets/$f)" = "600 $PUID"
done
check "app.db is owned by PUID:PGID" test "$(in_container stat -c '%u:%g' /data/app.db)" = "$PUID:$PGID"
stop_and_remove

echo "restore app.db without secrets/"
wipe
check "database extracts on its own" as_root tar -C /data -xpf /backup/appdata.tar --wildcards './app.db*'
check "secrets/ is not there before boot" bash -c "! docker run --rm -v '$DATA:/data' --entrypoint test '$IMAGE' -e /data/secrets"
start
for f in session-password token-vault.key; do
  check "secrets/$f is generated again at 0600" test "$(mode_owner /data/secrets/$f)" = "600 $PUID"
done
check "the new session password differs from the lost one" \
  test "$(in_container cat /data/secrets/session-password)" != "$OLD_SESSION_PASSWORD"
check "no setup code (the account is in app.db)" no_setup_code
check "the organizer can still log in" login
stop_and_remove

echo "a truncated archive"
as_root sh -c 'head -c 4096 /backup/appdata.tar > /backup/truncated.tar'
wipe
check "fails to extract" bash -c "! docker run --rm -v '$DATA:/data' -v '$BACKUP:/backup' --entrypoint tar '$IMAGE' -C /data -xpf /backup/truncated.tar 2>/dev/null"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"; exit 1
fi
echo "all checks passed"
