/*
 * nexusd - Nexus IoT Platform hardware daemon (pure C, no dependencies).
 *
 * It owns ALL the hardware; the Go backend only talks to it over a unix socket.
 *
 *   ADC      every `period` s: channel 0 = slot 1, channel 1 = slot 2.
 *            ~16.4 % of max (+-5) -> RS-485 module (pins = UART)
 *            ~91.6 % of max (+-5) -> relay module  (pins = GPIO)
 *            anything else        -> slot empty
 *            On a change the pin hook runs:  <hook> <slot> uart|gpio|none
 *   RS-485   slot with an RS-485 module: opens the UART, sets baud/parity/bits,
 *            reports received frames, transmits frames (drives the DE and /RE lines).
 *   relay    slot with a relay module: 4 GPIO channels.
 *   buttons  3 programmable buttons (GPIO input, debounced): press/release events.
 *   LEDs     3 programmable LEDs (GPIO output).
 *   system   CPU / RAM / disk / uptime from /proc.
 *
 * Protocol: newline-delimited JSON on a unix socket.
 *   daemon -> backend: module, system, button, led, relay, rs485, *_result
 *   backend -> daemon: snapshot, rescan, configure, led, relay, rs485_tx
 *
 * Build:  cc -O2 -Wall -o nexusd nexusd.c
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/gpio.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define NSLOTS 2
#define NBTN 3
#define NLED 3
#define NRELAY 4
#define MAXCLI 8
#define LINEMAX 4096
#define OUTMAX 2048
#define BIGOUT 4608
#define RXMAX 512

enum kind { K_UNKNOWN = -1, K_NONE = 0, K_RS485 = 1, K_RELAY = 2 };

typedef struct {
    char adc_path[NSLOTS][256];
    char uart_dev[NSLOTS][128];
    char hook[256];
    char sock[256];
    char disk_path[128];
    char gpio_root[128];   /* sysfs fallback, overridable for tests */
    int adc_max;
    int period;
    int confirm;
    double rs485_pct, relay_pct, tol_pct;
    int btn_gpio[NBTN], btn_active_low;
    int led_gpio[NLED], led_active_low;
    int relay_gpio[NSLOTS][NRELAY], relay_active_low;
    int de_gpio[NSLOTS], re_gpio[NSLOTS];
} cfg_t;

/* ---- GPIO line: character device (preferred) or sysfs fallback ---- */
typedef struct {
    int num;
    int fd;      /* line-handle fd (chardev) or value fd (sysfs) */
    int sysfs;
    int open_;
} gpio_t;

typedef struct {
    int cur;       /* applied kind, K_UNKNOWN until first confirmed sample */
    int pending;
    int pending_n;
    int adc_ok;
    long raw;
    double pct;
    /* RS-485 */
    int uart_fd;
    int baud, databits, stopbits;
    char parity[16];
    gpio_t de, re;
    unsigned char rx[RXMAX];
    size_t rx_len;
    long long rx_last;
    /* relay */
    gpio_t relay[NRELAY];
    int relay_on[NRELAY];
} slot_t;

typedef struct {
    int fd;
    char buf[LINEMAX];
    size_t len;
} cli_t;

static cfg_t cfg;
static slot_t slots[NSLOTS];
static cli_t clients[MAXCLI];
static gpio_t btn[NBTN], led[NLED];
static int btn_state[NBTN], btn_raw_last[NBTN], btn_raw_n[NBTN];
static int led_state[NLED];
static char last_sys[OUTMAX];
static volatile sig_atomic_t running = 1;

static unsigned long long cpu_prev_total, cpu_prev_busy;
static int cpu_have_prev;

static void logf_(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "nexusd: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static long long mono_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static double fabs_(double v) { return v < 0 ? -v : v; }

/* ---------------------------------------------------------------- config */

static void parse_int_list(const char *v, int *out, int n) {
    for (int i = 0; i < n; i++) {
        while (*v == ' ' || *v == ',') v++;
        if (!*v) break;
        out[i] = atoi(v);
        while (*v && *v != ',') v++;
    }
}

static void cfg_defaults(void) {
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.adc_path[0], sizeof cfg.adc_path[0], "/sys/bus/iio/devices/iio:device0/in_voltage0_raw");
    snprintf(cfg.adc_path[1], sizeof cfg.adc_path[1], "/sys/bus/iio/devices/iio:device0/in_voltage1_raw");
    snprintf(cfg.uart_dev[0], sizeof cfg.uart_dev[0], "/dev/ttyS1");
    snprintf(cfg.uart_dev[1], sizeof cfg.uart_dev[1], "/dev/ttyS4");
    snprintf(cfg.hook, sizeof cfg.hook, "/etc/nexus/hooks/module-hook.sh");
    snprintf(cfg.sock, sizeof cfg.sock, "/var/run/nexus/daemon.sock");
    snprintf(cfg.disk_path, sizeof cfg.disk_path, "/");
    snprintf(cfg.gpio_root, sizeof cfg.gpio_root, "/sys/class/gpio");
    cfg.adc_max = 4095;
    cfg.period = 3;
    cfg.confirm = 2;
    cfg.rs485_pct = 16.4;
    cfg.relay_pct = 91.6;
    cfg.tol_pct = 5.0;
    int b[NBTN] = {66, 69, 45}, l[NLED] = {49, 112, 20};
    memcpy(cfg.btn_gpio, b, sizeof b);
    memcpy(cfg.led_gpio, l, sizeof l);
    cfg.btn_active_low = 1;
    cfg.led_active_low = 0;
    int r1[NRELAY] = {115, 117, 15, 14}, r2[NRELAY] = {48, 60, 31, 30};
    memcpy(cfg.relay_gpio[0], r1, sizeof r1);
    memcpy(cfg.relay_gpio[1], r2, sizeof r2);
    cfg.relay_active_low = 0;
    cfg.de_gpio[0] = 115; cfg.re_gpio[0] = 117;
    cfg.de_gpio[1] = 48;  cfg.re_gpio[1] = 60;
}

static char *trim(char *s) {
    while (isspace((unsigned char)*s)) s++;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
    return s;
}

static void cfg_load(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        logf_("config %s not readable (%s), using defaults", path, strerror(errno));
        return;
    }
    char line[512];
    while (fgets(line, sizeof line, f)) {
        char *s = trim(line);
        if (!*s || *s == '#') continue;
        char *eq = strchr(s, '=');
        if (!eq) continue;
        *eq = 0;
        char *k = trim(s), *v = trim(eq + 1);
        char *hash = strchr(v, '#');
        if (hash) { *hash = 0; v = trim(v); }
        if (!strcmp(k, "adc0")) snprintf(cfg.adc_path[0], sizeof cfg.adc_path[0], "%s", v);
        else if (!strcmp(k, "adc1")) snprintf(cfg.adc_path[1], sizeof cfg.adc_path[1], "%s", v);
        else if (!strcmp(k, "uart_dev1")) snprintf(cfg.uart_dev[0], sizeof cfg.uart_dev[0], "%s", v);
        else if (!strcmp(k, "uart_dev2")) snprintf(cfg.uart_dev[1], sizeof cfg.uart_dev[1], "%s", v);
        else if (!strcmp(k, "hook")) snprintf(cfg.hook, sizeof cfg.hook, "%s", v);
        else if (!strcmp(k, "socket")) snprintf(cfg.sock, sizeof cfg.sock, "%s", v);
        else if (!strcmp(k, "disk_path")) snprintf(cfg.disk_path, sizeof cfg.disk_path, "%s", v);
        else if (!strcmp(k, "gpio_root")) snprintf(cfg.gpio_root, sizeof cfg.gpio_root, "%s", v);
        else if (!strcmp(k, "adc_max")) cfg.adc_max = atoi(v);
        else if (!strcmp(k, "period")) cfg.period = atoi(v);
        else if (!strcmp(k, "confirm")) cfg.confirm = atoi(v);
        else if (!strcmp(k, "rs485_percent")) cfg.rs485_pct = atof(v);
        else if (!strcmp(k, "relay_percent")) cfg.relay_pct = atof(v);
        else if (!strcmp(k, "tolerance")) cfg.tol_pct = atof(v);
        else if (!strcmp(k, "btn_gpio")) parse_int_list(v, cfg.btn_gpio, NBTN);
        else if (!strcmp(k, "btn_active_low")) cfg.btn_active_low = atoi(v);
        else if (!strcmp(k, "led_gpio")) parse_int_list(v, cfg.led_gpio, NLED);
        else if (!strcmp(k, "led_active_low")) cfg.led_active_low = atoi(v);
        else if (!strcmp(k, "relay1_gpios")) parse_int_list(v, cfg.relay_gpio[0], NRELAY);
        else if (!strcmp(k, "relay2_gpios")) parse_int_list(v, cfg.relay_gpio[1], NRELAY);
        else if (!strcmp(k, "relay_active_low")) cfg.relay_active_low = atoi(v);
        else if (!strcmp(k, "rs485_de1")) cfg.de_gpio[0] = atoi(v);
        else if (!strcmp(k, "rs485_re1")) cfg.re_gpio[0] = atoi(v);
        else if (!strcmp(k, "rs485_de2")) cfg.de_gpio[1] = atoi(v);
        else if (!strcmp(k, "rs485_re2")) cfg.re_gpio[1] = atoi(v);
        /* other keys belong to the backend - ignore */
    }
    fclose(f);
    if (cfg.adc_max < 1) cfg.adc_max = 4095;
    if (cfg.period < 1) cfg.period = 3;
    if (cfg.confirm < 1) cfg.confirm = 1;
}

/* ---------------------------------------------------------------- GPIO */

static int write_file(const char *path, const char *val) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t r = write(fd, val, strlen(val));
    close(fd);
    return r < 0 ? -1 : 0;
}

/* dir_out: 1 = output, 0 = input; init = initial PHYSICAL level for outputs */
static int gpio_open(gpio_t *g, int num, int dir_out, int init) {
    memset(g, 0, sizeof *g);
    g->num = num;
    g->fd = -1;
    if (num < 0) return -1;

    char path[160];
    snprintf(path, sizeof path, "/dev/gpiochip%d", num / 32);
    int chip = open(path, O_RDWR | O_CLOEXEC);
    if (chip >= 0) {
        struct gpiohandle_request rq;
        memset(&rq, 0, sizeof rq);
        rq.lineoffsets[0] = (unsigned)(num % 32);
        rq.flags = dir_out ? GPIOHANDLE_REQUEST_OUTPUT : GPIOHANDLE_REQUEST_INPUT;
        rq.default_values[0] = (unsigned char)(init ? 1 : 0);
        rq.lines = 1;
        snprintf(rq.consumer_label, sizeof rq.consumer_label, "nexusd");
        int r = ioctl(chip, GPIO_GET_LINEHANDLE_IOCTL, &rq);
        close(chip);
        if (r == 0) {
            g->fd = rq.fd;
            g->open_ = 1;
            return 0;
        }
    }
    /* sysfs fallback */
    char tmp[160], numbuf[16];
    snprintf(numbuf, sizeof numbuf, "%d", num);
    snprintf(tmp, sizeof tmp, "%s/export", cfg.gpio_root);
    write_file(tmp, numbuf); /* may already be exported */
    snprintf(tmp, sizeof tmp, "%s/gpio%d/direction", cfg.gpio_root, num);
    if (write_file(tmp, dir_out ? (init ? "high" : "low") : "in") != 0) return -1;
    snprintf(tmp, sizeof tmp, "%s/gpio%d/value", cfg.gpio_root, num);
    g->fd = open(tmp, dir_out ? O_RDWR : O_RDONLY);
    if (g->fd < 0) return -1;
    g->sysfs = 1;
    g->open_ = 1;
    return 0;
}

static void gpio_close(gpio_t *g) {
    if (!g->open_) return;
    close(g->fd);
    if (g->sysfs) { /* leave it as a harmless input */
        char tmp[160];
        snprintf(tmp, sizeof tmp, "%s/gpio%d/direction", cfg.gpio_root, g->num);
        write_file(tmp, "in");
    }
    g->open_ = 0;
    g->fd = -1;
}

static int gpio_get(gpio_t *g) {
    if (!g->open_) return -1;
    if (!g->sysfs) {
        struct gpiohandle_data d;
        memset(&d, 0, sizeof d);
        if (ioctl(g->fd, GPIOHANDLE_GET_LINE_VALUES_IOCTL, &d) < 0) return -1;
        return d.values[0] ? 1 : 0;
    }
    char c;
    if (pread(g->fd, &c, 1, 0) != 1) return -1;
    return c == '1' ? 1 : 0;
}

static int gpio_set(gpio_t *g, int v) {
    if (!g->open_) return -1;
    if (!g->sysfs) {
        struct gpiohandle_data d;
        memset(&d, 0, sizeof d);
        d.values[0] = (unsigned char)(v ? 1 : 0);
        return ioctl(g->fd, GPIOHANDLE_SET_LINE_VALUES_IOCTL, &d) < 0 ? -1 : 0;
    }
    return pwrite(g->fd, v ? "1" : "0", 1, 0) == 1 ? 0 : -1;
}

/* ---------------------------------------------------------------- ADC */

static int read_adc(const char *path, long *out) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char b[64];
    char *r = fgets(b, sizeof b, f);
    fclose(f);
    if (!r) return -1;
    char *end;
    long v = strtol(b, &end, 10);
    if (end == b) return -1;
    *out = v;
    return 0;
}

static int classify(double pct) {
    if (fabs_(pct - cfg.rs485_pct) <= cfg.tol_pct) return K_RS485;
    if (fabs_(pct - cfg.relay_pct) <= cfg.tol_pct) return K_RELAY;
    return K_NONE;
}
static const char *kind_name(int k) { return k == K_RS485 ? "rs485" : k == K_RELAY ? "relay" : "none"; }
static const char *kind_mode(int k) { return k == K_RS485 ? "uart" : k == K_RELAY ? "gpio" : "none"; }

/* ---------------------------------------------------------------- JSON */

static void json_esc(char *dst, size_t n, const char *src) {
    size_t o = 0;
    for (; *src && o + 7 < n; src++) {
        unsigned char c = (unsigned char)*src;
        if (c == '"' || c == '\\') { dst[o++] = '\\'; dst[o++] = (char)c; }
        else if (c < 0x20) { o += (size_t)snprintf(dst + o, n - o, "\\u%04x", c); }
        else dst[o++] = (char)c;
    }
    dst[o] = 0;
}

/* tiny flat-JSON reader for commands (strings without escapes, numbers, booleans) */
static int json_get(const char *line, const char *key, char *out, size_t n) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(line, pat);
    if (!p) return 0;
    p += strlen(pat);
    while (*p && (isspace((unsigned char)*p) || *p == ':')) p++;
    size_t o = 0;
    if (*p == '"') {
        p++;
        while (*p && *p != '"' && o + 1 < n) out[o++] = *p++;
    } else {
        while (*p && *p != ',' && *p != '}' && !isspace((unsigned char)*p) && o + 1 < n) out[o++] = *p++;
    }
    out[o] = 0;
    return 1;
}
static int json_bool(const char *line, const char *key, int *out) {
    char v[16];
    if (!json_get(line, key, v, sizeof v)) return 0;
    *out = (!strcmp(v, "true") || !strcmp(v, "1")) ? 1 : 0;
    return 1;
}

/* ---------------------------------------------------------------- clients */

static void cli_close(cli_t *c) {
    if (c->fd >= 0) close(c->fd);
    c->fd = -1;
    c->len = 0;
}

static void cli_send(cli_t *c, const char *msg) {
    size_t n = strlen(msg);
    ssize_t r = send(c->fd, msg, n, MSG_NOSIGNAL | MSG_DONTWAIT);
    if (r < 0 || (size_t)r != n) cli_close(c); /* slow or dead reader - drop it, it reconnects */
}

static void broadcast(const char *msg) {
    for (int i = 0; i < MAXCLI; i++)
        if (clients[i].fd >= 0) cli_send(&clients[i], msg);
}

static void fmt_module(char *out, size_t n, int slot) {
    slot_t *s = &slots[slot];
    int k = s->cur == K_UNKNOWN ? K_NONE : s->cur;
    snprintf(out, n,
             "{\"type\":\"module\",\"slot\":%d,\"module\":\"%s\",\"mode\":\"%s\",\"raw\":%ld,\"percent\":%.1f,\"adcOk\":%s,\"ts\":%lld}\n",
             slot + 1, kind_name(k), kind_mode(k), s->raw, s->pct, s->adc_ok ? "true" : "false", now_ms());
}
static void fmt_button(char *out, size_t n, int i) {
    snprintf(out, n, "{\"type\":\"button\",\"n\":%d,\"pressed\":%s,\"ts\":%lld}\n", i + 1, btn_state[i] ? "true" : "false", now_ms());
}
static void fmt_led(char *out, size_t n, int i) {
    snprintf(out, n, "{\"type\":\"led\",\"n\":%d,\"on\":%s,\"ts\":%lld}\n", i + 1, led_state[i] ? "true" : "false", now_ms());
}
static void fmt_relay(char *out, size_t n, int slot) {
    slot_t *s = &slots[slot];
    snprintf(out, n, "{\"type\":\"relay\",\"slot\":%d,\"states\":[%d,%d,%d,%d],\"ts\":%lld}\n", slot + 1,
             s->relay_on[0], s->relay_on[1], s->relay_on[2], s->relay_on[3], now_ms());
}

static void hex_encode(char *dst, const unsigned char *src, size_t n) {
    static const char H[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { dst[2 * i] = H[src[i] >> 4]; dst[2 * i + 1] = H[src[i] & 15]; }
    dst[2 * n] = 0;
}
static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
static int hex_decode(const char *s, unsigned char *dst, size_t max) {
    size_t n = strlen(s);
    if (n % 2 || n / 2 > max) return -1;
    for (size_t i = 0; i < n / 2; i++) {
        int a = hexval(s[2 * i]), b = hexval(s[2 * i + 1]);
        if (a < 0 || b < 0) return -1;
        dst[i] = (unsigned char)(a * 16 + b);
    }
    return (int)(n / 2);
}

static void emit_rs485(int slot, const char *dir, const unsigned char *d, size_t n) {
    char hex[2 * RXMAX + 2], msg[BIGOUT];
    hex_encode(hex, d, n);
    snprintf(msg, sizeof msg, "{\"type\":\"rs485\",\"slot\":%d,\"dir\":\"%s\",\"hex\":\"%s\",\"ts\":%lld}\n", slot + 1, dir, hex, now_ms());
    broadcast(msg);
}

/* ---------------------------------------------------------------- hook */

static int run_hook(int slot, const char *action) {
    if (access(cfg.hook, X_OK) != 0) {
        logf_("hook %s is not executable - pins NOT switched (slot %d -> %s)", cfg.hook, slot + 1, action);
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        char sl[16];
        snprintf(sl, sizeof sl, "%d", slot + 1);
        setenv("NEXUS_SLOT", sl, 1);
        setenv("NEXUS_UART_DEV", cfg.uart_dev[slot], 1);
        execl(cfg.hook, cfg.hook, sl, action, (char *)NULL);
        _exit(127);
    }
    int st = 0;
    for (int waited = 0; waited < 100; waited++) { /* up to ~5 s */
        pid_t r = waitpid(pid, &st, WNOHANG);
        if (r == pid) {
            int rc = WIFEXITED(st) ? WEXITSTATUS(st) : 128;
            if (rc != 0) logf_("hook slot %d %s exited with %d", slot + 1, action, rc);
            return rc;
        }
        usleep(50000);
    }
    kill(pid, SIGKILL);
    waitpid(pid, &st, 0);
    logf_("hook slot %d %s timed out", slot + 1, action);
    return -1;
}

/* ---------------------------------------------------------------- RS-485 UART */

static int baud_ok(int b, speed_t *sp) {
    speed_t s;
    switch (b) {
    case 1200: s = B1200; break;
    case 2400: s = B2400; break;
    case 4800: s = B4800; break;
    case 9600: s = B9600; break;
    case 19200: s = B19200; break;
    case 38400: s = B38400; break;
    case 57600: s = B57600; break;
    case 115200: s = B115200; break;
    case 230400: s = B230400; break;
    case 460800: s = B460800; break;
    case 921600: s = B921600; break;
    default: return 0;
    }
    if (sp) *sp = s;
    return 1;
}

static int uart_apply(slot_t *s) {
    struct termios t;
    speed_t sp;
    if (s->uart_fd < 0 || !baud_ok(s->baud, &sp)) return -1;
    if (tcgetattr(s->uart_fd, &t) < 0) return -1;
    cfmakeraw(&t);
    t.c_cflag |= CLOCAL | CREAD;
    t.c_cflag &= ~(tcflag_t)(CSIZE | PARENB | PARODD | CSTOPB | CRTSCTS);
    t.c_cflag |= s->databits == 7 ? CS7 : CS8;
    if (!strcmp(s->parity, "even")) t.c_cflag |= PARENB;
    else if (!strcmp(s->parity, "odd")) t.c_cflag |= PARENB | PARODD;
    if (s->stopbits == 2) t.c_cflag |= CSTOPB;
    t.c_cc[VMIN] = 0;
    t.c_cc[VTIME] = 0;
    cfsetispeed(&t, sp);
    cfsetospeed(&t, sp);
    tcflush(s->uart_fd, TCIOFLUSH);
    return tcsetattr(s->uart_fd, TCSANOW, &t);
}

static void rs485_idle_levels(slot_t *s) { /* receive: driver off, receiver on */
    gpio_set(&s->de, 0);
    gpio_set(&s->re, 0);
}

static void rs485_setup(int i) {
    slot_t *s = &slots[i];
    s->baud = 9600; s->databits = 8; s->stopbits = 1;
    snprintf(s->parity, sizeof s->parity, "none");
    if (gpio_open(&s->de, cfg.de_gpio[i], 1, 0) != 0) logf_("slot %d: cannot open DE gpio %d", i + 1, cfg.de_gpio[i]);
    if (gpio_open(&s->re, cfg.re_gpio[i], 1, 0) != 0) logf_("slot %d: cannot open /RE gpio %d", i + 1, cfg.re_gpio[i]);
    s->uart_fd = open(cfg.uart_dev[i], O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (s->uart_fd < 0) { logf_("slot %d: cannot open %s: %s", i + 1, cfg.uart_dev[i], strerror(errno)); return; }
    if (uart_apply(s) != 0) logf_("slot %d: cannot configure %s: %s", i + 1, cfg.uart_dev[i], strerror(errno));
    s->rx_len = 0;
}

static void rs485_teardown(int i) {
    slot_t *s = &slots[i];
    if (s->uart_fd >= 0) close(s->uart_fd);
    s->uart_fd = -1;
    gpio_close(&s->de);
    gpio_close(&s->re);
    s->rx_len = 0;
}

static void rx_flush(int i) {
    slot_t *s = &slots[i];
    if (s->rx_len) { emit_rs485(i, "rx", s->rx, s->rx_len); s->rx_len = 0; }
}

static void uart_read(int i) {
    slot_t *s = &slots[i];
    unsigned char b[256];
    ssize_t r = read(s->uart_fd, b, sizeof b);
    if (r <= 0) return;
    for (ssize_t k = 0; k < r; k++) {
        if (s->rx_len >= RXMAX) rx_flush(i);
        s->rx[s->rx_len++] = b[k];
    }
    s->rx_last = mono_ms();
}

/* ---------------------------------------------------------------- relay */

static int relay_phys(int logical) { return cfg.relay_active_low ? !logical : logical; }

static void relay_setup(int i) {
    slot_t *s = &slots[i];
    for (int c = 0; c < NRELAY; c++) {
        s->relay_on[c] = 0;
        if (gpio_open(&s->relay[c], cfg.relay_gpio[i][c], 1, relay_phys(0)) != 0)
            logf_("slot %d: cannot open relay gpio %d", i + 1, cfg.relay_gpio[i][c]);
    }
}
static void relay_teardown(int i) {
    slot_t *s = &slots[i];
    for (int c = 0; c < NRELAY; c++) {
        if (s->relay[c].open_) gpio_set(&s->relay[c], relay_phys(0)); /* leave everything OFF */
        gpio_close(&s->relay[c]);
        s->relay_on[c] = 0;
    }
}

/* ---------------------------------------------------------------- slots */

static void teardown_slot(int i) {
    rs485_teardown(i);
    relay_teardown(i);
}

static void apply_kind(int i, int k) {
    teardown_slot(i);
    run_hook(i, kind_mode(k)); /* pin mux (uart / gpio / none) */
    if (k == K_RS485) rs485_setup(i);
    else if (k == K_RELAY) relay_setup(i);
    slots[i].cur = k;
}

static void scan_slots(int force_report) {
    char msg[OUTMAX];
    for (int i = 0; i < NSLOTS; i++) {
        slot_t *s = &slots[i];
        long raw;
        if (read_adc(cfg.adc_path[i], &raw) != 0) {
            if (s->adc_ok) logf_("cannot read ADC %s: %s", cfg.adc_path[i], strerror(errno));
            s->adc_ok = 0;
            if (force_report) { fmt_module(msg, sizeof msg, i); broadcast(msg); }
            continue; /* keep last known state, do not touch pins */
        }
        s->adc_ok = 1;
        s->raw = raw;
        s->pct = 100.0 * (double)raw / (double)cfg.adc_max;
        int k = classify(s->pct);

        if (k == s->pending) s->pending_n++;
        else { s->pending = k; s->pending_n = 1; }

        int changed = 0;
        if (s->pending_n >= cfg.confirm && s->cur != k) {
            logf_("slot %d: %s -> %s (ADC %ld = %.1f%%)", i + 1,
                  s->cur == K_UNKNOWN ? "init" : kind_name(s->cur), kind_name(k), raw, s->pct);
            apply_kind(i, k);
            changed = 1;
        }
        if (changed || force_report) {
            fmt_module(msg, sizeof msg, i); broadcast(msg);
            fmt_relay(msg, sizeof msg, i); broadcast(msg);
        }
    }
}

/* ---------------------------------------------------------------- buttons / LEDs */

static void io_setup(void) {
    for (int i = 0; i < NBTN; i++) {
        if (gpio_open(&btn[i], cfg.btn_gpio[i], 0, 0) != 0) logf_("cannot open button gpio %d", cfg.btn_gpio[i]);
        int v = gpio_get(&btn[i]);
        btn_state[i] = v < 0 ? 0 : (cfg.btn_active_low ? !v : v);
        btn_raw_last[i] = btn_state[i];
        btn_raw_n[i] = 0;
    }
    for (int i = 0; i < NLED; i++) {
        led_state[i] = 0;
        int phys = cfg.led_active_low ? 1 : 0; /* start OFF */
        if (gpio_open(&led[i], cfg.led_gpio[i], 1, phys) != 0) logf_("cannot open led gpio %d", cfg.led_gpio[i]);
    }
}

/* every ~10 ms; a level must be stable for 3 samples (30 ms) to count */
static void scan_buttons(void) {
    char msg[OUTMAX];
    for (int i = 0; i < NBTN; i++) {
        int v = gpio_get(&btn[i]);
        if (v < 0) continue;
        int pressed = cfg.btn_active_low ? !v : v;
        if (pressed == btn_raw_last[i]) { if (btn_raw_n[i] < 1000) btn_raw_n[i]++; }
        else { btn_raw_last[i] = pressed; btn_raw_n[i] = 1; }
        if (btn_raw_n[i] >= 3 && pressed != btn_state[i]) {
            btn_state[i] = pressed;
            fmt_button(msg, sizeof msg, i);
            broadcast(msg);
        }
    }
}

static void led_apply(int i, int on) {
    char msg[OUTMAX];
    led_state[i] = on;
    gpio_set(&led[i], cfg.led_active_low ? !on : on);
    fmt_led(msg, sizeof msg, i);
    broadcast(msg);
}

/* ---------------------------------------------------------------- system */

static void read_cpu_model(char *out, size_t n) {
    char model[128] = "", hw[128] = "";
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (f) {
        char l[256];
        while (fgets(l, sizeof l, f)) {
            char *c = strchr(l, ':');
            if (!c) continue;
            char *v = trim(c + 1);
            *c = 0;
            char *k = trim(l);
            if (!model[0] && (!strcmp(k, "model name") || !strcmp(k, "Processor"))) snprintf(model, sizeof model, "%s", v);
            if (!hw[0] && !strcmp(k, "Hardware")) snprintf(hw, sizeof hw, "%s", v);
        }
        fclose(f);
    }
    if (hw[0] && model[0]) snprintf(out, n, "%s (%s)", hw, model);
    else snprintf(out, n, "%s", model[0] ? model : hw[0] ? hw : "unknown");
}

static double cpu_usage(void) {
    FILE *f = fopen("/proc/stat", "r");
    if (!f) return 0;
    unsigned long long u = 0, ni = 0, sy = 0, id = 0, iow = 0, irq = 0, sirq = 0, st = 0;
    int r = fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", &u, &ni, &sy, &id, &iow, &irq, &sirq, &st);
    fclose(f);
    if (r < 4) return 0;
    unsigned long long idle = id + iow;
    unsigned long long total = u + ni + sy + id + iow + irq + sirq + st;
    unsigned long long busy = total - idle;
    double pct = 0;
    if (cpu_have_prev && total > cpu_prev_total)
        pct = 100.0 * (double)(busy - cpu_prev_busy) / (double)(total - cpu_prev_total);
    cpu_prev_total = total;
    cpu_prev_busy = busy;
    cpu_have_prev = 1;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return pct;
}

static void ram_usage(double *total_mb, double *used_mb) {
    unsigned long long tot = 0, avail = 0, freeb = 0, buf = 0, cached = 0;
    int have_avail = 0;
    FILE *f = fopen("/proc/meminfo", "r");
    *total_mb = *used_mb = 0;
    if (!f) return;
    char l[160];
    while (fgets(l, sizeof l, f)) {
        unsigned long long v;
        if (sscanf(l, "MemTotal: %llu", &v) == 1) tot = v;
        else if (sscanf(l, "MemAvailable: %llu", &v) == 1) { avail = v; have_avail = 1; }
        else if (sscanf(l, "MemFree: %llu", &v) == 1) freeb = v;
        else if (sscanf(l, "Buffers: %llu", &v) == 1) buf = v;
        else if (sscanf(l, "Cached: %llu", &v) == 1) cached = v;
    }
    fclose(f);
    if (!have_avail) avail = freeb + buf + cached;
    *total_mb = (double)tot / 1024.0;
    *used_mb = (double)(tot > avail ? tot - avail : 0) / 1024.0;
}

static void fmt_system(char *out, size_t n) {
    struct utsname u;
    char linux_ver[160] = "", cpu[256], cpue[512], lve[320];
    if (uname(&u) == 0) snprintf(linux_ver, sizeof linux_ver, "%s %s", u.sysname, u.release);
    read_cpu_model(cpu, sizeof cpu);
    json_esc(cpue, sizeof cpue, cpu);
    json_esc(lve, sizeof lve, linux_ver);

    double rt, ru, up = 0;
    ram_usage(&rt, &ru);
    FILE *f = fopen("/proc/uptime", "r");
    if (f) { if (fscanf(f, "%lf", &up) != 1) up = 0; fclose(f); }

    double dt = 0, du = 0;
    struct statvfs sv;
    if (statvfs(cfg.disk_path, &sv) == 0) {
        dt = (double)sv.f_blocks * (double)sv.f_frsize / 1048576.0;
        du = dt - (double)sv.f_bfree * (double)sv.f_frsize / 1048576.0;
    }
    snprintf(out, n,
             "{\"type\":\"system\",\"ts\":%lld,\"linux\":\"%s\",\"cpuModel\":\"%s\",\"cpu\":%.1f,"
             "\"ramTotalMb\":%.1f,\"ramUsedMb\":%.1f,\"uptime\":%.0f,\"diskTotalMb\":%.1f,\"diskUsedMb\":%.1f}\n",
             now_ms(), lve, cpue, cpu_usage(), rt, ru, up, dt, du);
}

/* ---------------------------------------------------------------- commands */

static void reply_result(cli_t *c, const char *type, int slot, int ok, const char *err) {
    char e[160], reply[320];
    json_esc(e, sizeof e, err ? err : "");
    snprintf(reply, sizeof reply, "{\"type\":\"%s\",\"slot\":%d,\"ok\":%s,\"error\":\"%s\"}\n", type, slot, ok ? "true" : "false", e);
    cli_send(c, reply);
}

static void cmd_configure(cli_t *c, const char *line) {
    char slot_s[16], baud[16], par[16], db[8], sb[8], proto[24];
    int slot = -1;
    if (json_get(line, "slot", slot_s, sizeof slot_s)) slot = atoi(slot_s) - 1;
    const char *err = NULL;

    if (slot < 0 || slot >= NSLOTS) err = "bad slot";
    else if (slots[slot].cur != K_RS485) err = "slot has no RS-485 module";
    else if (!json_get(line, "baud", baud, sizeof baud) || !baud_ok(atoi(baud), NULL)) err = "unsupported baud (1200..921600 standard rates)";
    else if (!json_get(line, "parity", par, sizeof par) || (strcmp(par, "none") && strcmp(par, "even") && strcmp(par, "odd"))) err = "bad parity";
    else if (!json_get(line, "databits", db, sizeof db) || (atoi(db) != 7 && atoi(db) != 8)) err = "bad databits";
    else if (!json_get(line, "stopbits", sb, sizeof sb) || (atoi(sb) != 1 && atoi(sb) != 2)) err = "bad stopbits";
    else if (!json_get(line, "protocol", proto, sizeof proto) || (strcmp(proto, "modbus_rtu") && strcmp(proto, "modbus_ascii"))) err = "bad protocol";
    if (err) { reply_result(c, "configure_result", slot + 1, 0, err); return; }

    slot_t *s = &slots[slot];
    s->baud = atoi(baud);
    snprintf(s->parity, sizeof s->parity, "%s", par);
    s->databits = atoi(db);
    s->stopbits = atoi(sb);
    if (s->uart_fd < 0 || uart_apply(s) != 0) { reply_result(c, "configure_result", slot + 1, 0, "cannot configure UART (see logread)"); return; }
    logf_("slot %d: UART %d %d%c%d", slot + 1, s->baud, s->databits, par[0] == 'n' ? 'N' : par[0] == 'e' ? 'E' : 'O', s->stopbits);
    reply_result(c, "configure_result", slot + 1, 1, "");
}

static void cmd_led(cli_t *c, const char *line) {
    char v[16];
    int on = 0;
    if (!json_get(line, "n", v, sizeof v) || !json_bool(line, "on", &on)) { reply_result(c, "led_result", 0, 0, "bad request"); return; }
    int n = atoi(v) - 1;
    if (n < 0 || n >= NLED) { reply_result(c, "led_result", n + 1, 0, "bad led"); return; }
    if (!led[n].open_) { reply_result(c, "led_result", n + 1, 0, "led gpio not available"); return; }
    led_apply(n, on);
    reply_result(c, "led_result", n + 1, 1, "");
}

static void cmd_relay(cli_t *c, const char *line) {
    char v[16];
    int on = 0, slot = -1, ch = -1;
    if (json_get(line, "slot", v, sizeof v)) slot = atoi(v) - 1;
    if (json_get(line, "ch", v, sizeof v)) ch = atoi(v) - 1;
    if (!json_bool(line, "on", &on) || slot < 0 || slot >= NSLOTS || ch < 0 || ch >= NRELAY) { reply_result(c, "relay_result", slot + 1, 0, "bad request"); return; }
    slot_t *s = &slots[slot];
    if (s->cur != K_RELAY) { reply_result(c, "relay_result", slot + 1, 0, "slot has no relay module"); return; }
    if (!s->relay[ch].open_) { reply_result(c, "relay_result", slot + 1, 0, "relay gpio not available"); return; }
    if (gpio_set(&s->relay[ch], relay_phys(on)) != 0) { reply_result(c, "relay_result", slot + 1, 0, "gpio write failed"); return; }
    s->relay_on[ch] = on;
    char msg[OUTMAX];
    fmt_relay(msg, sizeof msg, slot);
    broadcast(msg);
    reply_result(c, "relay_result", slot + 1, 1, "");
}

static void cmd_rs485_tx(cli_t *c, const char *line) {
    static char hexbuf[2 * RXMAX + 8];
    unsigned char data[RXMAX];
    char v[16];
    int slot = -1;
    if (json_get(line, "slot", v, sizeof v)) slot = atoi(v) - 1;
    if (slot < 0 || slot >= NSLOTS || !json_get(line, "hex", hexbuf, sizeof hexbuf)) { reply_result(c, "rs485_tx_result", slot + 1, 0, "bad request"); return; }
    slot_t *s = &slots[slot];
    if (s->cur != K_RS485 || s->uart_fd < 0) { reply_result(c, "rs485_tx_result", slot + 1, 0, "slot has no working RS-485 module"); return; }
    int n = hex_decode(hexbuf, data, sizeof data);
    if (n <= 0) { reply_result(c, "rs485_tx_result", slot + 1, 0, "bad data"); return; }

    rx_flush(slot);
    gpio_set(&s->de, 1); /* driver on, receiver off */
    gpio_set(&s->re, 1);
    int off = 0, ok = 1;
    long long end = mono_ms() + 2000;
    while (off < n) {
        ssize_t w = write(s->uart_fd, data + off, (size_t)(n - off));
        if (w > 0) { off += (int)w; continue; }
        if (w < 0 && errno != EAGAIN && errno != EINTR) { ok = 0; break; }
        struct pollfd p = { s->uart_fd, POLLOUT, 0 };
        poll(&p, 1, 50);
        if (mono_ms() > end) { ok = 0; break; }
    }
    if (ok) tcdrain(s->uart_fd);
    tcflush(s->uart_fd, TCIFLUSH); /* drop our own echo, if any */
    rs485_idle_levels(s);
    s->rx_len = 0;
    if (ok) emit_rs485(slot, "tx", data, (size_t)n);
    reply_result(c, "rs485_tx_result", slot + 1, ok, ok ? "" : "write failed");
}

static void send_snapshot(cli_t *c) {
    char msg[OUTMAX];
    for (int i = 0; i < NSLOTS; i++) {
        fmt_module(msg, sizeof msg, i); cli_send(c, msg); if (c->fd < 0) return;
        fmt_relay(msg, sizeof msg, i); cli_send(c, msg); if (c->fd < 0) return;
    }
    for (int i = 0; i < NBTN; i++) { fmt_button(msg, sizeof msg, i); cli_send(c, msg); if (c->fd < 0) return; }
    for (int i = 0; i < NLED; i++) { fmt_led(msg, sizeof msg, i); cli_send(c, msg); if (c->fd < 0) return; }
    if (last_sys[0]) cli_send(c, last_sys);
}

static void handle_line(cli_t *c, const char *line) {
    char cmd[32];
    if (!json_get(line, "cmd", cmd, sizeof cmd)) return;
    if (!strcmp(cmd, "snapshot")) send_snapshot(c);
    else if (!strcmp(cmd, "rescan")) scan_slots(1);
    else if (!strcmp(cmd, "configure")) cmd_configure(c, line);
    else if (!strcmp(cmd, "led")) cmd_led(c, line);
    else if (!strcmp(cmd, "relay")) cmd_relay(c, line);
    else if (!strcmp(cmd, "rs485_tx")) cmd_rs485_tx(c, line);
}

static void cli_read(cli_t *c) {
    ssize_t r = recv(c->fd, c->buf + c->len, sizeof c->buf - c->len - 1, MSG_DONTWAIT);
    if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) { cli_close(c); return; }
    if (r < 0) return;
    c->len += (size_t)r;
    c->buf[c->len] = 0;
    char *nl;
    char *start = c->buf;
    while ((nl = strchr(start, '\n'))) {
        *nl = 0;
        handle_line(c, start);
        if (c->fd < 0) return;
        start = nl + 1;
    }
    size_t rest = c->len - (size_t)(start - c->buf);
    memmove(c->buf, start, rest);
    c->len = rest;
    if (c->len >= sizeof c->buf - 1) c->len = 0; /* garbage without newline */
}

/* ---------------------------------------------------------------- main */

static void on_signal(int sig) { (void)sig; running = 0; }

static int listen_socket(void) {
    char dir[256];
    snprintf(dir, sizeof dir, "%s", cfg.sock);
    char *sl = strrchr(dir, '/');
    if (sl) { *sl = 0; mkdir(dir, 0755); }
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un a;
    if (strlen(cfg.sock) >= sizeof a.sun_path) { errno = ENAMETOOLONG; close(fd); return -1; }
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof a.sun_path, "%s", cfg.sock);
    unlink(cfg.sock);
    if (bind(fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(fd, 4) < 0) { close(fd); return -1; }
    chmod(cfg.sock, 0660);
    return fd;
}

int main(int argc, char **argv) {
    const char *conf = "/etc/nexus/nexus.conf";
    for (int i = 1; i < argc; i++)
        if (!strcmp(argv[i], "-c") && i + 1 < argc) conf = argv[++i];
        else { fprintf(stderr, "usage: nexusd [-c /etc/nexus/nexus.conf]\n"); return 2; }

    cfg_defaults();
    cfg_load(conf);
    for (int i = 0; i < NSLOTS; i++) {
        slots[i].cur = K_UNKNOWN;
        slots[i].pending = K_UNKNOWN;
        slots[i].uart_fd = -1;
    }
    for (int i = 0; i < MAXCLI; i++) clients[i].fd = -1;

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    int lfd = listen_socket();
    if (lfd < 0) { logf_("cannot listen on %s: %s", cfg.sock, strerror(errno)); return 1; }
    io_setup();
    logf_("started: socket %s, period %ds, adc0 %s, adc1 %s", cfg.sock, cfg.period, cfg.adc_path[0], cfg.adc_path[1]);

    long long next_tick = mono_ms(); /* first tick immediately */
    long long next_btn = next_tick;
    while (running) {
        long long now = mono_ms();
        if (now >= next_btn) { scan_buttons(); next_btn = now + 10; }
        for (int i = 0; i < NSLOTS; i++)
            if (slots[i].rx_len && now - slots[i].rx_last >= 20) rx_flush(i); /* frame = 20 ms of silence */
        if (now >= next_tick) {
            scan_slots(0);
            fmt_system(last_sys, sizeof last_sys);
            broadcast(last_sys);
            next_tick += (long long)cfg.period * 1000;
            if (next_tick < now) next_tick = now + (long long)cfg.period * 1000;
        }

        struct pollfd pfd[MAXCLI + 1 + NSLOTS];
        int idx[MAXCLI + 1 + NSLOTS], n = 0;
        pfd[n].fd = lfd; pfd[n].events = POLLIN; idx[n] = -1; n++;
        for (int i = 0; i < MAXCLI; i++)
            if (clients[i].fd >= 0) { pfd[n].fd = clients[i].fd; pfd[n].events = POLLIN; idx[n] = i; n++; }
        for (int i = 0; i < NSLOTS; i++)
            if (slots[i].uart_fd >= 0) { pfd[n].fd = slots[i].uart_fd; pfd[n].events = POLLIN; idx[n] = 100 + i; n++; }
        int pr = poll(pfd, (nfds_t)n, 10);
        if (pr <= 0) continue;
        for (int j = 0; j < n; j++) {
            if (!(pfd[j].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            if (idx[j] == -1) {
                int cfd = accept(lfd, NULL, NULL);
                if (cfd < 0) continue;
                int slot = -1;
                for (int i = 0; i < MAXCLI; i++) if (clients[i].fd < 0) { slot = i; break; }
                if (slot < 0) { close(cfd); continue; }
                clients[slot].fd = cfd;
                clients[slot].len = 0;
                send_snapshot(&clients[slot]);
            } else if (idx[j] >= 100) {
                uart_read(idx[j] - 100);
            } else {
                cli_read(&clients[idx[j]]);
            }
        }
    }
    for (int i = 0; i < NSLOTS; i++) { teardown_slot(i); }
    for (int i = 0; i < NLED; i++) { if (led[i].open_) gpio_set(&led[i], cfg.led_active_low ? 1 : 0); gpio_close(&led[i]); }
    for (int i = 0; i < NBTN; i++) gpio_close(&btn[i]);
    for (int i = 0; i < MAXCLI; i++) cli_close(&clients[i]);
    close(lfd);
    unlink(cfg.sock);
    logf_("stopped");
    return 0;
}
