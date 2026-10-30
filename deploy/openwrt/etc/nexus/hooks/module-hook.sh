#!/bin/sh
# Called by nexusd:  module-hook.sh <slot 1|2> <uart|gpio|none>   (pin multiplexer only)
#
#   uart       an RS-485 module was detected -> route the slot pins to the UART
#   gpio       a relay module was detected   -> route the slot pins to GPIO
#   none       slot is empty                 -> park the pins safely
#   configure  apply serial parameters (env: NEXUS_BAUD NEXUS_PARITY
#              NEXUS_DATABITS NEXUS_STOPBITS NEXUS_PROTOCOL)
#
# Always set: NEXUS_SLOT, NEXUS_UART_DEV.
#
# Pin map of this board (AM335x). Only the PAD MULTIPLEXER is switched here, by
# writing the Control Module registers (base 0x44E10000) with `io`.
# GPIO directions/levels, the UART and the relays are handled by nexusd itself.
#
#   slot  UART TXD pad (offset)      UART RXD pad (offset)       two more GPIO pads
#   1     uart1_txd  0x984 (mode 0)  uart1_rxd  0x980 (mode 0)   GPIO_115 (pad 0x9A4), GPIO_117 (pad 0x9AC)
#   2     gpmc_wpn   0x874 (mode 6)  gpmc_wait0 0x870 (mode 6)   GPIO_48  (pad 0x840), GPIO_60  (pad 0x878)
#
#   uart  (RS-485 module): TXD/RXD pads -> UART; the two GPIO pads -> GPIO (DE and /RE lines)
#   gpio  (relay module) : TXD pad -> GPIO output (the single relay channel), RXD pad -> GPIO input
#   none  (empty slot)   : all four pads -> GPIO mode 7 as inputs (high-Z)

SLOT="$1"
ACTION="$2"
log() { logger -t nexus-hook "slot $SLOT: $*"; }

CM_BASE=${NEXUS_CM_BASE:-0x44E10000}      # AM335x Control Module

# pad value bits: [2:0] mode | [3] pull disable | [4] 1=pull-up | [5] receiver enable
PAD_OUT=0x08       # output, pull disabled
PAD_IN=0x27        # input (gpio mode 7), receiver on, pull-down
PAD_RX=0x30        # UART RX: receiver on, pull-up

case "$SLOT" in
  1) TX_OFF=0x984; RX_OFF=0x980; UART_MODE=0; GPIO_A_OFF=0x9A4; GPIO_B_OFF=0x9AC ;;
  2) TX_OFF=0x874; RX_OFF=0x870; UART_MODE=6; GPIO_A_OFF=0x840; GPIO_B_OFF=0x878 ;;
  *) echo "bad slot '$SLOT'" >&2; exit 2 ;;
esac

# write one pad configuration register using the OpenWrt `io` tool
# (also accepts busybox devmem / devmem2 if present)
pad() {  # pad <offset> <value>
  addr=$(printf '0x%08X' $((CM_BASE + $1)))
  val=$(printf '0x%X' $(($2)))
  if command -v io >/dev/null 2>&1; then
    out=$(io -4 -w "$addr" "$val" 2>&1) || out2=$(io -4 "$addr" "$val" 2>&1) || { log "io write $addr=$val failed: $out / $out2"; return 1; }
    got=$(io -4 -r "$addr" 2>&1 | awk '{print $NF}')
    log "pad $addr <- $val (read back: $got)"
    return 0
  elif command -v devmem >/dev/null 2>&1; then
    devmem "$addr" 32 "$val"
  elif command -v devmem2 >/dev/null 2>&1; then
    devmem2 "$addr" w "$val" >/dev/null
  else
    log "no io/devmem/devmem2 found - cannot switch pins (opkg install io)"; return 1
  fi
}

pins_uart() {
  pad "$TX_OFF" $((0x00 | UART_MODE)) && pad "$RX_OFF" $((PAD_RX | UART_MODE)) &&
    pad "$GPIO_A_OFF" $((PAD_OUT | 7)) && pad "$GPIO_B_OFF" $((PAD_OUT | 7))
}

pins_gpio() {
  # relay module: ONE channel on the UART TX pad -> plain GPIO output; RX pad -> GPIO input
  pad "$TX_OFF" $((PAD_OUT | 7)) && pad "$RX_OFF" "$PAD_IN"
}

pins_none() {
  pad "$TX_OFF" "$PAD_IN" && pad "$RX_OFF" "$PAD_IN" &&
    pad "$GPIO_A_OFF" "$PAD_IN" && pad "$GPIO_B_OFF" "$PAD_IN"
}
# ---------------------------------------------------------------------------

configure_uart() {
  dev="$NEXUS_UART_DEV"
  [ -c "$dev" ] || { log "UART device $dev does not exist"; return 1; }

  case "$NEXUS_PARITY" in
    even) par="parenb -parodd" ;;
    odd)  par="parenb parodd" ;;
    *)    par="-parenb" ;;
  esac
  [ "$NEXUS_STOPBITS" = "2" ] && stop="cstopb" || stop="-cstopb"
  [ "$NEXUS_DATABITS" = "7" ] && bits="cs7" || bits="cs8"

  # shellcheck disable=SC2086
  stty -F "$dev" raw -echo "$NEXUS_BAUD" $bits $par $stop clocal cread || return 1
  log "$dev: $NEXUS_BAUD $NEXUS_DATABITS $NEXUS_PARITY $NEXUS_STOPBITS ($NEXUS_PROTOCOL)"
}

case "$ACTION" in
  uart)      log "RS-485 module -> pins as UART"; pins_uart || { log "pin switch FAILED"; exit 1; } ;;
  gpio)      log "relay module -> pins as GPIO";  pins_gpio || { log "pin switch FAILED"; exit 1; } ;;
  none)      log "no module";                     pins_none || { log "pin switch FAILED"; exit 1; } ;;
  configure) configure_uart ;;
  *)         echo "usage: $0 <slot> uart|gpio|none|configure" >&2; exit 2 ;;
esac
