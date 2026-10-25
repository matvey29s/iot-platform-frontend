#!/bin/sh
# Called by nexusd:  module-hook.sh <slot 1|2> <uart|gpio|none|configure>
#
#   uart       an RS-485 module was detected -> route the slot pins to the UART
#   gpio       a relay module was detected   -> route the slot pins to GPIO
#   none       slot is empty                 -> park the pins safely
#   configure  apply serial parameters (env: NEXUS_BAUD NEXUS_PARITY
#              NEXUS_DATABITS NEXUS_STOPBITS NEXUS_PROTOCOL)
#
# Always set: NEXUS_SLOT, NEXUS_UART_DEV.
#
# Pin map of this board (AM335x). Pad mux is written straight into the Control
# Module registers (base 0x44E10000) with `devmem`; GPIO levels go through sysfs.
#
#   slot  UART TXD pad (offset)      UART RXD pad (offset)       GPIO lines
#   1     uart1_txd  0x984 (mode 0)  uart1_rxd  0x980 (mode 0)   GPIO_115 (gpio3_19, pad 0x9A4), GPIO_117 (gpio3_21, pad 0x9AC)
#   2     gpmc_wpn   0x874 (mode 6)  gpmc_wait0 0x870 (mode 6)   GPIO_48  (gpio1_16, pad 0x840), GPIO_60  (gpio1_28, pad 0x878)
#
# Behaviour:
#   uart  (RS-485 module): TXD/RXD pads -> UART mode; the two GPIO lines -> outputs, driven LOW
#   gpio  (relay module) : TXD/RXD pads -> GPIO mode as inputs; the two GPIO lines -> outputs, driven LOW
#   none  (empty slot)   : every pad -> GPIO mode as input (high-Z), GPIO lines released
# "LOW" is the safe default (relays off / RS-485 driver in receive). If your module
# needs another level or another role for these lines, change GPIO_IDLE below.

SLOT="$1"
ACTION="$2"
log() { logger -t nexus-hook "slot $SLOT: $*"; }

CM_BASE=${NEXUS_CM_BASE:-0x44E10000}      # AM335x Control Module
GPIO_ROOT=${NEXUS_GPIO_ROOT:-/sys/class/gpio}
GPIO_IDLE=0                               # level of the two GPIO lines in uart/gpio modes

# pad value bits: [2:0] mode | [3] pull disable | [4] 1=pull-up | [5] receiver enable
PAD_OUT=0x08       # output, pull disabled
PAD_IN=0x27        # input (gpio mode 7), receiver on, pull-down
PAD_RX=0x30        # UART RX: receiver on, pull-up

case "$SLOT" in
  1) TX_OFF=0x984; RX_OFF=0x980; UART_MODE=0
     GPIO_A=115; GPIO_A_OFF=0x9A4; GPIO_B=117; GPIO_B_OFF=0x9AC ;;
  2) TX_OFF=0x874; RX_OFF=0x870; UART_MODE=6
     GPIO_A=48;  GPIO_A_OFF=0x840; GPIO_B=60;  GPIO_B_OFF=0x878 ;;
  *) echo "bad slot '$SLOT'" >&2; exit 2 ;;
esac

# write one pad configuration register
pad() {  # pad <offset> <value>
  addr=$(printf '0x%08X' $((CM_BASE + $1)))
  if command -v devmem >/dev/null 2>&1; then
    devmem "$addr" 32 "$2"
  elif command -v devmem2 >/dev/null 2>&1; then
    devmem2 "$addr" w "$2" >/dev/null
  else
    log "neither devmem nor devmem2 found - cannot switch pins (opkg install devmem2)"; return 1
  fi
}

gpio_out() {  # gpio_out <number> <0|1>
  [ -d "$GPIO_ROOT/gpio$1" ] || echo "$1" > "$GPIO_ROOT/export" 2>/dev/null
  echo out > "$GPIO_ROOT/gpio$1/direction" && echo "$2" > "$GPIO_ROOT/gpio$1/value"
}
gpio_release() {  # gpio_release <number>
  [ -d "$GPIO_ROOT/gpio$1" ] || return 0
  echo in > "$GPIO_ROOT/gpio$1/direction" 2>/dev/null
  echo "$1" > "$GPIO_ROOT/unexport" 2>/dev/null
}

# the two GPIO lines: pad -> gpio mode (7), then outputs
lines_out() {
  pad "$GPIO_A_OFF" $((PAD_OUT | 7)) && pad "$GPIO_B_OFF" $((PAD_OUT | 7)) || return 1
  gpio_out "$GPIO_A" "$GPIO_IDLE" && gpio_out "$GPIO_B" "$GPIO_IDLE"
}

pins_uart() {
  pad "$TX_OFF" $((0x00 | UART_MODE)) && pad "$RX_OFF" $((PAD_RX | UART_MODE)) || return 1
  lines_out
}

pins_gpio() {
  pad "$TX_OFF" "$PAD_IN" && pad "$RX_OFF" "$PAD_IN" || return 1
  lines_out
}

pins_none() {
  gpio_release "$GPIO_A"; gpio_release "$GPIO_B"
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
