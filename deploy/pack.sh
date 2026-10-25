#!/bin/sh
# Build everything for the device on your PC and pack it.
#
#   ./deploy/pack.sh      ->  deploy/nexus-iot-openwrt.tar.gz
#
# Needs: Node 18+, Go 1.22+, and a C cross-compiler for ARMv7 (static):
#   - `zig` (any recent version) or Python `ziglang`  (pip install ziglang) - used automatically
#   - or set CC to your own compiler, e.g. CC=arm-openwrt-linux-muslgnueabi-gcc
# Then:  scp -O deploy/nexus-iot-openwrt.tar.gz root@<device-ip>:/tmp/
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
STAGE="$ROOT/deploy/out"
PKG="$STAGE/nexus-iot-openwrt"
rm -rf "$STAGE"; mkdir -p "$PKG/bin"

echo "== frontend"
npm run build
cp -R dist "$PKG/www"

echo "== backend (Go, linux/arm v7)"
( cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags="-s -w" -o "$PKG/bin/nexus-backend" . )

echo "== daemon (C, static ARMv7)"
if [ -n "${CC:-}" ]; then
  $CC -O2 -Wall -static -s -o "$PKG/bin/nexusd" daemon/nexusd.c
elif command -v zig >/dev/null 2>&1; then
  zig cc -target arm-linux-musleabihf -mcpu=cortex_a8 -O2 -Wall -static -s -o "$PKG/bin/nexusd" daemon/nexusd.c
elif python3 -c 'import ziglang' >/dev/null 2>&1; then
  python3 -m ziglang cc -target arm-linux-musleabihf -mcpu=cortex_a8 -O2 -Wall -static -s -o "$PKG/bin/nexusd" daemon/nexusd.c
else
  echo "No ARM C compiler found. Run  pip install ziglang  or set CC=<arm cross gcc>" >&2
  exit 1
fi

cp -R deploy/openwrt/etc deploy/openwrt/init "$PKG/"
cp deploy/openwrt/install.sh "$PKG/install.sh"
chmod 755 "$PKG/install.sh" "$PKG/bin/"*

COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ROOT/deploy/nexus-iot-openwrt.tar.gz" nexus-iot-openwrt
rm -rf "$STAGE"
echo "Created deploy/nexus-iot-openwrt.tar.gz"
