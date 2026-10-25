#!/bin/sh
# Nexus IoT Platform - installer for OpenWrt (busybox ash compatible).
#
# Serves the prebuilt web UI (./www) with a dedicated uhttpd instance, so the
# stock LuCI admin page on port 80 is left untouched.
#
#   ./install.sh             install or update, UI on port 8080
#   ./install.sh 8081        install or update on another port
#   ./install.sh --remove    uninstall
#
# Optional overrides (for non-standard layouts / testing):
#   NEXUS_DEST   where the site is copied     (default /opt/nexus-iot/www)
#   UHTTPD_INIT  uhttpd init script           (default /etc/init.d/uhttpd)
set -eu

NAME=nexus
DEST="${NEXUS_DEST:-/opt/nexus-iot/www}"
INIT="${UHTTPD_INIT:-/etc/init.d/uhttpd}"
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "ERROR: $*" >&2; exit 1; }

command -v uci >/dev/null 2>&1 || die "uci not found - this script is for OpenWrt"
[ -x "$INIT" ] || die "uhttpd is not installed (opkg install uhttpd  /  apk add uhttpd)"
case "$DEST" in /|"") die "refusing to use '$DEST' as install folder" ;; esac

# ---- uninstall -------------------------------------------------------------
if [ "${1:-}" = "--remove" ]; then
  uci -q delete "uhttpd.$NAME" || true
  uci commit uhttpd
  "$INIT" restart
  rm -rf "$DEST"
  rmdir "$(dirname "$DEST")" 2>/dev/null || true
  echo "Nexus IoT Platform removed."
  exit 0
fi

# ---- checks ----------------------------------------------------------------
PORT="${1:-8080}"
case "$PORT" in ''|*[!0-9]*) die "port must be a number, got '$PORT'" ;; esac
{ [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "port must be 1-65535"
[ -f "$HERE/www/index.html" ] || die "www/index.html not found next to install.sh"

# Only complain about a busy port if it is not our own instance already on it.
OLD=$(uci -q get "uhttpd.$NAME.listen_http" || true)
if [ "$OLD" != "0.0.0.0:$PORT" ]; then
  if netstat -ltn 2>/dev/null | grep -q ":$PORT "; then
    die "port $PORT is already in use - pick another: ./install.sh 8081"
  fi
fi

# ---- install ---------------------------------------------------------------
# Replace the old build completely so stale hashed files don't pile up in flash.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$HERE/www/." "$DEST/"

uci -q delete "uhttpd.$NAME" || true
uci set "uhttpd.$NAME=uhttpd"
uci add_list "uhttpd.$NAME.listen_http=0.0.0.0:$PORT"
uci set "uhttpd.$NAME.home=$DEST"
uci commit uhttpd

"$INIT" enable 2>/dev/null || true   # make sure uhttpd starts at boot
"$INIT" restart                      # note: LuCI reconnects after ~1 s

# ---- verify + report -------------------------------------------------------
sleep 1
if wget -q -O /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
  echo "OK: web UI is answering on port $PORT"
else
  echo "WARNING: nothing answered on 127.0.0.1:$PORT yet - check: logread | grep uhttpd" >&2
fi

echo
echo "Open from a computer in the same network:"
IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}' || true)
if [ -n "$IPS" ]; then
  for ip in $IPS; do echo "  http://$ip:$PORT/"; done
else
  echo "  http://<device-ip>:$PORT/"
fi
