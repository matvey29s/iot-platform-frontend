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
# NEXUS_ROOT is only for testing the installer on a normal PC (files go under that folder,
# services are not touched). On the device leave it unset.
R="${NEXUS_ROOT:-}"
CONF=$R/etc/nexus/nexus.conf
APP=$R/opt/nexus-iot
BIN=$R/usr/bin
INITD=$R/etc/init.d

svc() { if [ -n "$R" ]; then echo "[test] $*"; else "$@"; fi; }

die() { echo "ERROR: $*" >&2; exit 1; }
if [ -z "$R" ]; then
  [ "$(id -u)" = 0 ] || die "run as root"
  [ -f /etc/rc.common ] || die "this script is for OpenWrt (no /etc/rc.common)"
fi

stop_services() {
  for s in nexus-backend nexusd; do
    if [ -x "$INITD/$s" ]; then
      svc "$INITD/$s" stop 2>/dev/null || true
      svc "$INITD/$s" disable 2>/dev/null || true
    fi
  done
  return 0   # (set -e: a false `if` as the last command must not end the script)
}

# ---- uninstall -------------------------------------------------------------
case "${1:-}" in
  --remove|--purge)
    stop_services
    rm -f "$BIN/nexusd" "$BIN/nexus-backend" "$INITD/nexusd" "$INITD/nexus-backend"
    rm -rf "$APP/www"
    if [ "$1" = "--purge" ]; then rm -rf "$R/etc/nexus" "$APP"; else echo "Kept: $R/etc/nexus and $APP/data"; fi
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
if [ -z "$R" ] && command -v uci >/dev/null 2>&1 && uci -q get uhttpd.nexus >/dev/null 2>&1; then
  uci -q delete uhttpd.nexus; uci commit uhttpd
  [ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart || true
  echo "Removed the old uhttpd 'nexus' instance (the Go backend serves the UI now)."
fi

stop_services

# ---- config (never overwrite the user's edits) -----------------------------
mkdir -p "$R/etc/nexus/hooks" "$APP/data"
HOOK=$R/etc/nexus/hooks/module-hook.sh
if [ ! -f "$CONF" ]; then
  cp "$HERE/etc/nexus/nexus.conf" "$CONF"
elif ! grep -q '^conf_version=2' "$CONF"; then
  # config from an older version: back it up, take the new one, keep the user's own settings
  cp "$CONF" "$CONF.bak"
  cp "$HERE/etc/nexus/nexus.conf" "$CONF"
  for key in listen tolerance adc_mode adc_ain0 adc_ain1 slot1_force slot2_force uart_dev1 uart_dev2 eth1 period; do
    line=$(grep "^$key=" "$CONF.bak" | head -1 || true)
    [ -z "$line" ] && continue
    if grep -q -e "^$key=" -e "^#$key=" "$CONF"; then sed -i -e "s|^$key=.*|$line|" -e "s|^#$key=.*|$line|" "$CONF"; else echo "$line" >> "$CONF"; fi
  done
  echo "Old $CONF replaced with the new one (backup: $CONF.bak)"
else
  cp "$HERE/etc/nexus/nexus.conf" "$CONF.new"
  echo "Kept your $CONF (new defaults saved as $CONF.new)"
fi
if [ ! -f "$HOOK" ] || ! grep -q 'ONE channel' "$HOOK"; then
  [ -f "$HOOK" ] && cp "$HOOK" "$HOOK.bak" && echo "Old pin hook replaced (backup: $HOOK.bak)"
  cp "$HERE/etc/nexus/hooks/module-hook.sh" "$HOOK"
else
  cp "$HERE/etc/nexus/hooks/module-hook.sh" "$HOOK.new"
  echo "Kept your pin hook (new template saved as module-hook.sh.new)"
fi
chmod 755 $R/etc/nexus/hooks/module-hook.sh

if [ -n "$PORT" ]; then
  if grep -q '^listen=' "$CONF"; then sed -i "s|^listen=.*|listen=0.0.0.0:$PORT|" "$CONF"
  else echo "listen=0.0.0.0:$PORT" >> "$CONF"; fi
fi
LISTEN=$(sed -n 's/^listen=//p' "$CONF" | head -n 1)
PORT="${LISTEN##*:}"; PORT="${PORT:-8080}"

# ---- files -----------------------------------------------------------------
mkdir -p "$BIN" "$INITD"
cp "$HERE/bin/nexusd" "$BIN/nexusd"
cp "$HERE/bin/nexus-backend" "$BIN/nexus-backend"
chmod 755 "$BIN/nexusd" "$BIN/nexus-backend"
rm -rf "$APP/www"; mkdir -p "$APP/www"
cp -R "$HERE/www/." "$APP/www/"
cp "$HERE/init/nexusd" "$INITD/nexusd"
cp "$HERE/init/nexus-backend" "$INITD/nexus-backend"
chmod 755 "$INITD/nexusd" "$INITD/nexus-backend"

# ---- start + autostart ------------------------------------------------------
svc "$INITD/nexusd" enable;        svc "$INITD/nexusd" start
svc "$INITD/nexus-backend" enable; svc "$INITD/nexus-backend" start

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
echo "Pins are switched by /etc/nexus/hooks/module-hook.sh (needs the io tool and CONFIG_DEVMEM in the kernel)."
command -v io >/dev/null 2>&1 || command -v devmem >/dev/null 2>&1 || command -v devmem2 >/dev/null 2>&1 || echo "WARNING: no io/devmem found - install one (opkg install io), otherwise pins cannot be switched." >&2
