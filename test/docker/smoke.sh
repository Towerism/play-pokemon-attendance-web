#!/usr/bin/env bash
# Container smoke test for the `app` image (ADR-0006: the entrypoint needs its own tests).
#
#   test/docker/smoke.sh [image]        default image: play-pokemon-attendance:test
#
# Runs the image the way Unraid does (one /data bind mount, PUID/PGID, no other
# settings) and checks: healthy, files owned by PUID:PGID, secrets mode 0600,
# not running as root, setup code logged once, readable logs (JSON on request),
# graceful stop within Docker's 10 s timeout, and a restart that keeps state.
set -euo pipefail

IMAGE="${1:-play-pokemon-attendance:test}"
PUID=1234
PGID=2345
NAME="ppa-smoke-$$"
DATA="$(mktemp -d)"
FAILURES=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files are owned by PUID; remove them from inside a container.
  docker run --rm -v "$DATA:/data" --entrypoint sh "$IMAGE" -c 'rm -rf /data/* /data/.[!.]*' >/dev/null 2>&1 || true
  rmdir "$DATA" 2>/dev/null || true
}
trap cleanup EXIT

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

start() {
  docker run -d --name "$NAME" -e PUID=$PUID -e PGID=$PGID -e TZ=America/Chicago -v "$DATA:/data" "$@" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "container never became healthy:"; docker logs "$NAME"; return 1
}

in_container() { docker exec "$NAME" "$@"; }

echo "first boot"
start
check "app.db created and owned by PUID:PGID" \
  test "$(in_container stat -c '%u:%g' /data/app.db)" = "$PUID:$PGID"
for f in session-password token-vault.key; do
  check "secrets/$f is 0600 and owned by PUID" \
    test "$(in_container stat -c '%a %u' /data/secrets/$f)" = "600 $PUID"
done
# The oldest node process is the server (later ones are our own `docker exec node`).
server_owner() {
  in_container sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$" | sort -n); do
    [ "$(cat /proc/$p/comm 2>/dev/null)" = node ] && { stat -c "%u:%g" /proc/$p; break; }; done'
}
check "node runs as PUID:PGID, not root" test "$(server_owner)" = "$PUID:$PGID"
check "setup code printed to the log" \
  grep -Eq 'setup code: [A-Z2-9]{4}-[A-Z2-9]{4}' <(docker logs "$NAME" 2>&1)
check "the setup code line is readable, in the exact form E2E and the organizer look for" \
  grep -Eq '^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\] INFO: \[setup\] No organizer account yet\. Open the app and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}$' <(docker logs "$NAME" 2>&1)
check "the log is human-readable: no JSON records" \
  bash -c "! docker logs '$NAME' 2>&1 | grep -q '^{\"level\"'"
check "TZ is honoured" test "$(in_container date +%Z)" != "UTC"
check "no secret value in the log" \
  bash -c "! docker logs '$NAME' 2>&1 | grep -qF \"\$(docker exec '$NAME' cat /data/secrets/session-password)\""

SETUP_CODE="$(docker logs "$NAME" 2>&1 | grep -Eo '[A-Z2-9]{4}-[A-Z2-9]{4}' | tail -1)"
check "first-run setup creates the organizer" \
  in_container node -e "
    fetch('http://127.0.0.1:3000/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: '$SETUP_CODE', username: 'organizer', password: 'correct horse' }) })
    .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"

started=$(date +%s)
docker stop "$NAME" >/dev/null
check "stops gracefully within the 10 s timeout" test $(( $(date +%s) - started )) -lt 10
check "exit code is clean (not SIGKILL)" test "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")" != 137
docker rm "$NAME" >/dev/null

echo "second boot (same /data)"
start
check "no setup code once an account exists" \
  bash -c "! docker logs '$NAME' 2>&1 | grep -q 'setup code'"
check "existing account can log in" \
  in_container node -e "
    fetch('http://127.0.0.1:3000/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'organizer', password: 'correct horse' }) })
    .then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"
check "image HEALTHCHECK reports healthy" bash -c "
  for _ in \$(seq 1 40); do
    [ \"\$(docker inspect -f '{{.State.Health.Status}}' '$NAME')\" = healthy ] && exit 0; sleep 1
  done; exit 1"

docker rm -f "$NAME" >/dev/null
docker run --rm -v "$DATA:/data" --entrypoint sh "$IMAGE" -c 'rm -rf /data/* /data/.[!.]*' >/dev/null

echo "fresh boot with NUXT_LOG_FORMAT=json"
start -e NUXT_LOG_FORMAT=json
check "the setup code line is a JSON record" \
  grep -Eq '^\{"level":30,.*"scope":"setup","msg":"No organizer account yet\. Open the app and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}"\}$' <(docker logs "$NAME" 2>&1)

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"; docker logs "$NAME" 2>&1 | tail -40; exit 1
fi
echo "all checks passed"
