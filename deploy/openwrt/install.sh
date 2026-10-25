#!/bin/sh
# Nexus IoT Platform - installer for OpenWrt (busybox ash compatible).
#
#   sh install.sh             install or update (UI on port 8080, or the port already configured)
#   sh install.sh 8081        install or update on another port
#   sh install.sh --remove    uninstall (keeps /etc/nexus and saved data)
#   sh install.sh --purge     uninstall and delete config + saved data
#
# Installs: /usr/bin/nexusd (C daemon), /usr/bin/nexus-backend (Go server),
# procd services nexusd + nexus-backend, config /etc/nexus, UI /opt/nexus-iot/www.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CONF=/etc/nexus/nexus.conf
APP=/opt/nexus-iot

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -d /etc/init.d ] && [ -f /etc/rc.common ] || die "this script is for OpenWrt (no /etc/rc.common)"

stop_services() {
  for s in nexus-backend nexusd; do
    [ -x "/etc/init.d/$s" ] && { "/etc/init.d/$s" stop 2>/dev/null || true; "/etc/init.d/$s" disable 2>/dev/null || true; }
  done
}

# ---- uninstall -------------------------------------------------------------
case "${1:-}" in
  --remove|--purge)
    stop_services
    rm -f /usr/bin/nexusd /usr/bin/nexus-backend /etc/init.d/nexusd /etc/init.d/nexus-backend
    rm -rf "$APP/www"
    if [ "$1" = "--purge" ]; then rm -rf /etc/nexus "$APP"; else echo "Kept: /etc/nexus and $APP/data"; fi
    echo "Nexus IoT Platform removed."
    exit 0 ;;
esac

# ---- checks ----------------------------------------------------------------
for f in bin/nexusd bin/nexus-backend www/index.html etc/nexus/nexus.conf init/nexusd init/nexus-backend; do
  [ -f "$HERE/$f" ] || die "$f not found next to install.sh - did you unpack the whole archive?"
done

PORT="${1:-}"
if [ -n "$PORT" ]; then
  case "$PORT" in *[!0-9]*) die "port must be a number, got '$PORT'" ;; esac
  { [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "port must be 1-65535"
fi

# ---- clean up the previous (static-only) version, if it was installed ------
if command -v uci >/dev/null 2>&1 && uci -q get uhttpd.nexus >/dev/null 2>&1; then
  uci -q delete uhttpd.nexus; uci commit uhttpd
  [ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart || true
  echo "Removed the old uhttpd 'nexus' instance (the Go backend serves the UI now)."
fi

stop_services

# ---- config (never overwrite the user's edits) -----------------------------
mkdir -p /etc/nexus/hooks "$APP/data"
if [ ! -f "$CONF" ]; then
  cp "$HERE/etc/nexus/nexus.conf" "$CONF"
else
  cp "$HERE/etc/nexus/nexus.conf" "$CONF.new"
  echo "Kept your $CONF (new defaults saved as $CONF.new)"
fi
if [ ! -f /etc/nexus/hooks/module-hook.sh ]; then
  cp "$HERE/etc/nexus/hooks/module-hook.sh" /etc/nexus/hooks/module-hook.sh
else
  cp "$HERE/etc/nexus/hooks/module-hook.sh" /etc/nexus/hooks/module-hook.sh.new
  echo "Kept your pin hook (new template saved as module-hook.sh.new)"
fi
chmod 755 /etc/nexus/hooks/module-hook.sh

if [ -n "$PORT" ]; then
  if grep -q '^listen=' "$CONF"; then sed -i "s|^listen=.*|listen=0.0.0.0:$PORT|" "$CONF"
  else echo "listen=0.0.0.0:$PORT" >> "$CONF"; fi
fi
LISTEN=$(sed -n 's/^listen=//p' "$CONF" | head -n 1)
PORT="${LISTEN##*:}"; PORT="${PORT:-8080}"

# ---- files -----------------------------------------------------------------
cp "$HERE/bin/nexusd" /usr/bin/nexusd
cp "$HERE/bin/nexus-backend" /usr/bin/nexus-backend
chmod 755 /usr/bin/nexusd /usr/bin/nexus-backend
rm -rf "$APP/www"; mkdir -p "$APP/www"
cp -R "$HERE/www/." "$APP/www/"
cp "$HERE/init/nexusd" /etc/init.d/nexusd
cp "$HERE/init/nexus-backend" /etc/init.d/nexus-backend
chmod 755 /etc/init.d/nexusd /etc/init.d/nexus-backend

# ---- start + autostart ------------------------------------------------------
/etc/init.d/nexusd enable;        /etc/init.d/nexusd start
/etc/init.d/nexus-backend enable; /etc/init.d/nexus-backend start

# ---- verify + report -------------------------------------------------------
sleep 3
if wget -q -O - "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"daemon":true'; then
  echo "OK: backend and daemon are running."
elif wget -q -O /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  echo "WARNING: backend answers, but the daemon is not connected - check: logread | grep nexusd" >&2
else
  echo "WARNING: nothing answered on port $PORT - check: logread | grep nexus" >&2
fi

echo
echo "Open from a computer in the same network:"
IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}' || true)
if [ -n "$IPS" ]; then for ip in $IPS; do echo "  http://$ip:$PORT/"; done
else echo "  http://<device-ip>:$PORT/"; fi
echo
echo "Pins are switched by /etc/nexus/hooks/module-hook.sh (needs busybox devmem or devmem2)."
command -v devmem >/dev/null 2>&1 || command -v devmem2 >/dev/null 2>&1 || echo "WARNING: no devmem/devmem2 found - install one, otherwise pins cannot be switched." >&2
