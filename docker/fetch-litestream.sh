#!/bin/sh
# Installs the one Litestream release the kit supports, shipped by @towerism/selfhost-kit (ADR-0004).
#
#   fetch-litestream.sh <dest-dir>      e.g. in an app's Litestream build stage: /usr/local/bin
#
# The version and its sha256 live only here, so a Litestream update reaches every app as a kit
# release. The archive is verified before anything is extracted, and nothing is installed unless it
# matches. linux/amd64 only: the apps target Unraid on amd64 (architecture §2), and Renovate can keep
# one checksum current. Needs wget or curl, sha256sum and tar (an Alpine or Debian base has them).
set -eu

# renovate: datasource=github-release-attachments depName=benbjohnson/litestream
LITESTREAM_VERSION=v0.5.17
LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d

fail() {
  echo "[fetch-litestream] $*" >&2
  exit 1
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  fail "usage: fetch-litestream.sh <dest-dir>"
fi
dest="$1"

arch="${TARGETARCH:-$(uname -m)}"
case "$arch" in
  amd64 | x86_64) ;;
  *) fail "Litestream is pinned for linux/amd64 only (got $arch)" ;;
esac

archive="litestream-${LITESTREAM_VERSION#v}-linux-x86_64.tar.gz"
url="https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/${archive}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if command -v wget >/dev/null 2>&1; then
  wget -q -O "$work/$archive" "$url" || fail "download failed: $url"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$work/$archive" "$url" || fail "download failed: $url"
else
  fail "neither wget nor curl is installed"
fi

if ! echo "$LITESTREAM_SHA256  $work/$archive" | sha256sum -c - >/dev/null 2>&1; then
  fail "checksum mismatch for $archive (expected $LITESTREAM_SHA256)"
fi

tar -xzf "$work/$archive" -C "$work" litestream
chmod 0755 "$work/litestream"
mkdir -p "$dest"
mv "$work/litestream" "$dest/litestream"
"$dest/litestream" version
