#!/usr/bin/env bash
# Restore drill for the `app` image: the backup and restore steps of
# docs/deploy/unraid.md, automated so CI proves they still work.
#
#   test/docker/restore-drill.sh [image]   default image: play-pokemon-attendance:test
#
# Full archive: set up the organizer, stop, tar the appdata folder (as Appdata
# Backup does), wipe it, extract the archive as root (files come back root-owned),
# start, and check the box came back: healthy, no setup code, the organizer can
# log in, secrets unchanged at 0600, files owned by PUID:PGID, and a TDF stored
# before the backup downloads byte for byte (ADR-0012).
# Database without secrets/: the app still starts, generates new secrets at 0600,
# keeps the account (password hashes live in app.db) and asks for no setup code;
# the archived TDF can't be opened with the new key (409), and nothing else breaks.
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

# A made-up tournament file (no real player), kept in the encrypted TDF archive.
TDF='<?xml version="1.0" encoding="UTF-8"?>
<tournament type="2" gametype="TRADING_CARD_GAME" mode="LEAGUECHALLENGE">
  <data><name>Drill Cup</name><id>26-10-000999</id><startdate>10/14/2026</startdate></data>
  <players><player userid="1234567"><firstname>Drill</firstname><lastname>Player</lastname><birthdate>01/02/2012</birthdate></player></players>
</tournament>'

# Runs JS in the container as the logged-in organizer: call(path, init) keeps the
# session cookie, and the file is in process.env.TDF. Exits 0 when the JS returns true.
as_organizer() {
  docker exec -e TDF="$TDF" "$NAME" node -e "
    let cookie = '';
    const call = async (path, init = {}) => {
      const res = await fetch('http://127.0.0.1:3000' + path, { ...init, headers: { 'content-type': 'application/json', cookie } });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return res;
    };
    const json = (body) => JSON.stringify(body);
    (async () => {
      const login = await call('/api/auth/login', { method: 'POST', body: json({ username: 'organizer', password: 'correct horse' }) });
      if (login.status !== 200) return false;
      $1
    })().then((ok) => process.exit(ok ? 0 : 1), () => process.exit(1));"
}
store_tdf() {
  as_organizer "
    const preview = await call('/api/sessions/2026-10-14/tdf', { method: 'POST', body: json({ filename: 'drill.tdf', content: process.env.TDF }) });
    if (preview.status !== 200) return false;
    const { uploadId } = await preview.json();
    return (await call('/api/sessions/2026-10-14/tdf/' + uploadId + '/commit', { method: 'POST', body: '{}' })).status === 200;"
}
# tdf_download <expected status>: 200 also means the bytes match the stored file.
tdf_download() {
  as_organizer "
    const { files } = await (await call('/api/tdf-files')).json();
    const file = files.find((f) => f.filename === 'drill.tdf');
    if (!file) return false;
    const res = await call('/api/tdf-files/' + file.id + '/download');
    if (res.status !== $1) return false;
    return res.status !== 200 || (await res.text()) === process.env.TDF;"
}
no_setup_code() { ! logs | grep -q 'setup code'; }
wipe() { as_root sh -c 'rm -rf /data/* /data/.[!.]*'; }
secret_sums() { as_root sh -c 'cd /data/secrets && sha256sum session-password token-vault.key tdf-vault.key'; }
mode_owner() { in_container stat -c '%a %u' "$1"; }

echo "live box"
start
SETUP_CODE="$(logs | grep -Eo 'setup code: [A-Z2-9]{4}-[A-Z2-9]{4}' | tail -1 | cut -d' ' -f3)"
check "first-run setup creates the organizer" \
  api /api/auth/setup "{ setupCode: '$SETUP_CODE', username: 'organizer', password: 'correct horse' }"
check "a TDF is imported and kept in the archive" store_tdf
check "the archived TDF downloads byte for byte" tdf_download 200
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
check "the TDF stored before the backup downloads byte for byte" tdf_download 200
for f in session-password token-vault.key tdf-vault.key; do
  check "secrets/$f is 0600 and owned by PUID" test "$(mode_owner /data/secrets/$f)" = "600 $PUID"
done
check "app.db is owned by PUID:PGID" test "$(in_container stat -c '%u:%g' /data/app.db)" = "$PUID:$PGID"
stop_and_remove

echo "restore app.db without secrets/"
wipe
check "database extracts on its own" as_root tar -C /data -xpf /backup/appdata.tar --wildcards './app.db*'
check "secrets/ is not there before boot" bash -c "! docker run --rm -v '$DATA:/data' --entrypoint test '$IMAGE' -e /data/secrets"
start
for f in session-password token-vault.key tdf-vault.key; do
  check "secrets/$f is generated again at 0600" test "$(mode_owner /data/secrets/$f)" = "600 $PUID"
done
check "the new session password differs from the lost one" \
  test "$(in_container cat /data/secrets/session-password)" != "$OLD_SESSION_PASSWORD"
check "no setup code (the account is in app.db)" no_setup_code
check "the organizer can still log in" login
check "the archived TDF can't be opened with the new key (409)" tdf_download 409
stop_and_remove

echo "a truncated archive"
as_root sh -c 'head -c 4096 /backup/appdata.tar > /backup/truncated.tar'
wipe
check "fails to extract" bash -c "! docker run --rm -v '$DATA:/data' -v '$BACKUP:/backup' --entrypoint tar '$IMAGE' -C /data -xpf /backup/truncated.tar 2>/dev/null"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"; exit 1
fi
echo "all checks passed"
