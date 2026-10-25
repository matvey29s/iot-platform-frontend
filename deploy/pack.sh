#!/bin/sh
# Build the UI and pack it for the device (run on your PC, not on the device).
#
#   ./deploy/pack.sh      ->  deploy/nexus-iot-openwrt.tar.gz
#
# Then:  scp deploy/nexus-iot-openwrt.tar.gz root@<device-ip>:/tmp/
#        (if scp fails on OpenWrt/dropbear, use  scp -O ...)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

npm run build

STAGE="$ROOT/deploy/out"
PKG="$STAGE/nexus-iot-openwrt"
rm -rf "$STAGE"
mkdir -p "$PKG"
cp -R dist "$PKG/www"
cp deploy/openwrt/install.sh "$PKG/install.sh"
chmod 755 "$PKG/install.sh"

COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ROOT/deploy/nexus-iot-openwrt.tar.gz" nexus-iot-openwrt
rm -rf "$STAGE"
echo "Created deploy/nexus-iot-openwrt.tar.gz"
