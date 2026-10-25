/*
 * nexusd - Nexus IoT Platform hardware daemon (pure C, no dependencies).
 *
 * Every `period` seconds (default 3):
 *   1. reads ADC channel 0 and 1 (IIO sysfs, raw value 0..adc_max)
 *   2. classifies each expansion slot by the ADC level:
 *        ~20 % of max -> RS-485 module  (pins must be UART)
 *        ~50 % of max -> relay module   (pins must be GPIO)
 *        anything else -> slot empty
 *   3. when a slot's type changes it runs the hook script
 *        <hook> <slot> uart|gpio|none
 *      (this is where the pins are switched - see etc/nexus/hooks/module-hook.sh)
 *   4. samples Linux metrics (CPU, RAM, disk, uptime) from /proc
 *
 * The Go backend connects to a unix socket and gets newline-delimited JSON:
 *   {"type":"module",...}  on every slot change (and once on connect)
 *   {"type":"system",...}  every period
 * and may send commands, one JSON object per line:
 *   {"cmd":"snapshot"}   {"cmd":"rescan"}
 *   {"cmd":"configure","slot":1,"baud":9600,"parity":"none","databits":8,"stopbits":1,"protocol":"modbus_rtu"}
 *
 * Build:  cc -O2 -Wall -o nexusd nexusd.c
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define NSLOTS 2
#define MAXCLI 8
#define LINEMAX 2048
#define OUTMAX 2048

enum kind { K_UNKNOWN = -1, K_NONE = 0, K_RS485 = 1, K_RELAY = 2 };

typedef struct {
    char adc_path[NSLOTS][256];
    char uart_dev[NSLOTS][128];
    char hook[256];
    char sock[256];
    char disk_path[128];
    int adc_max;
    int period;
    int confirm;
    double rs485_pct, relay_pct, tol_pct;
} cfg_t;

typedef struct {
    int cur;       /* applied kind, K_UNKNOWN until first confirmed sample */
    int pending;   /* candidate kind */
    int pending_n; /* consecutive samples of the candidate */
    int adc_ok;
    long raw;
    double pct;
} slot_t;

typedef struct {
    int fd;
    char buf[LINEMAX];
    size_t len;
} cli_t;

static char last_sys[OUTMAX]; /* last system sample, replayed to new clients */
static cfg_t cfg;
static slot_t slots[NSLOTS];
static cli_t clients[MAXCLI];
static volatile sig_atomic_t running = 1;

/* last CPU counters for usage delta */
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

/* ---------------------------------------------------------------- config */

static void cfg_defaults(void) {
    memset(&cfg, 0, sizeof cfg);
    snprintf(cfg.adc_path[0], sizeof cfg.adc_path[0], "/sys/bus/iio/devices/iio:device0/in_voltage0_raw");
    snprintf(cfg.adc_path[1], sizeof cfg.adc_path[1], "/sys/bus/iio/devices/iio:device0/in_voltage1_raw");
    snprintf(cfg.uart_dev[0], sizeof cfg.uart_dev[0], "/dev/ttyS1");
    snprintf(cfg.uart_dev[1], sizeof cfg.uart_dev[1], "/dev/ttyS2");
    snprintf(cfg.hook, sizeof cfg.hook, "/etc/nexus/hooks/module-hook.sh");
    snprintf(cfg.sock, sizeof cfg.sock, "/var/run/nexus/daemon.sock");
    snprintf(cfg.disk_path, sizeof cfg.disk_path, "/");
    cfg.adc_max = 4095;
    cfg.period = 3;
    cfg.confirm = 2;
    cfg.rs485_pct = 20.0;
    cfg.relay_pct = 50.0;
    cfg.tol_pct = 7.0;
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
        if (!strcmp(k, "adc0")) snprintf(cfg.adc_path[0], sizeof cfg.adc_path[0], "%s", v);
        else if (!strcmp(k, "adc1")) snprintf(cfg.adc_path[1], sizeof cfg.adc_path[1], "%s", v);
        else if (!strcmp(k, "uart_dev1")) snprintf(cfg.uart_dev[0], sizeof cfg.uart_dev[0], "%s", v);
        else if (!strcmp(k, "uart_dev2")) snprintf(cfg.uart_dev[1], sizeof cfg.uart_dev[1], "%s", v);
        else if (!strcmp(k, "hook")) snprintf(cfg.hook, sizeof cfg.hook, "%s", v);
        else if (!strcmp(k, "socket")) snprintf(cfg.sock, sizeof cfg.sock, "%s", v);
        else if (!strcmp(k, "disk_path")) snprintf(cfg.disk_path, sizeof cfg.disk_path, "%s", v);
        else if (!strcmp(k, "adc_max")) cfg.adc_max = atoi(v);
        else if (!strcmp(k, "period")) cfg.period = atoi(v);
        else if (!strcmp(k, "confirm")) cfg.confirm = atoi(v);
        else if (!strcmp(k, "rs485_percent")) cfg.rs485_pct = atof(v);
        else if (!strcmp(k, "relay_percent")) cfg.relay_pct = atof(v);
        else if (!strcmp(k, "tolerance")) cfg.tol_pct = atof(v);
        /* other keys belong to the backend - ignore */
    }
    fclose(f);
    if (cfg.adc_max < 1) cfg.adc_max = 4095;
    if (cfg.period < 1) cfg.period = 3;
    if (cfg.confirm < 1) cfg.confirm = 1;
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

static double fabs_(double v) { return v < 0 ? -v : v; }

static int classify(double pct) {
    if (fabs_(pct - cfg.rs485_pct) <= cfg.tol_pct) return K_RS485;
    if (fabs_(pct - cfg.relay_pct) <= cfg.tol_pct) return K_RELAY;
    return K_NONE;
}

static const char *kind_name(int k) {
    return k == K_RS485 ? "rs485" : k == K_RELAY ? "relay" : "none";
}
static const char *kind_mode(int k) {
    return k == K_RS485 ? "uart" : k == K_RELAY ? "gpio" : "none";
}

/* ---------------------------------------------------------------- JSON out */

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

/* tiny flat-JSON reader for commands (strings without escapes, numbers) */
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

/* ---------------------------------------------------------------- hook */

/* Run the pin-switching hook. env: NEXUS_SLOT, NEXUS_UART_DEV (+ extras). */
static int run_hook(int slot, const char *action, char **extra_env) {
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
        for (int i = 0; extra_env && extra_env[i]; i++) putenv(extra_env[i]);
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

/* ---------------------------------------------------------------- slots */

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
            run_hook(i, kind_mode(k), NULL);
            s->cur = k;
            changed = 1;
        }
        if (changed || force_report) { fmt_module(msg, sizeof msg, i); broadcast(msg); }
    }
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

static void cmd_configure(cli_t *c, const char *line) {
    char v[64], slot_s[16], baud[16], par[16], db[8], sb[8], proto[24];
    char e_baud[48], e_par[48], e_db[48], e_sb[48], e_proto[64];
    char reply[160];
    int slot = -1;
    if (json_get(line, "slot", slot_s, sizeof slot_s)) slot = atoi(slot_s) - 1;
    int ok = 0;
    const char *err = "bad request";

    if (slot < 0 || slot >= NSLOTS) err = "bad slot";
    else if (slots[slot].cur != K_RS485) err = "slot has no RS-485 module";
    else if (!json_get(line, "baud", baud, sizeof baud) || atoi(baud) < 300 || atoi(baud) > 4000000) err = "bad baud";
    else if (!json_get(line, "parity", par, sizeof par) || (strcmp(par, "none") && strcmp(par, "even") && strcmp(par, "odd"))) err = "bad parity";
    else if (!json_get(line, "databits", db, sizeof db) || (atoi(db) != 7 && atoi(db) != 8)) err = "bad databits";
    else if (!json_get(line, "stopbits", sb, sizeof sb) || (atoi(sb) != 1 && atoi(sb) != 2)) err = "bad stopbits";
    else if (!json_get(line, "protocol", proto, sizeof proto) || (strcmp(proto, "modbus_rtu") && strcmp(proto, "modbus_ascii"))) err = "bad protocol";
    else {
        /* only validated values reach the environment of the hook */
        snprintf(e_baud, sizeof e_baud, "NEXUS_BAUD=%d", atoi(baud));
        snprintf(e_par, sizeof e_par, "NEXUS_PARITY=%s", par);
        snprintf(e_db, sizeof e_db, "NEXUS_DATABITS=%d", atoi(db));
        snprintf(e_sb, sizeof e_sb, "NEXUS_STOPBITS=%d", atoi(sb));
        snprintf(e_proto, sizeof e_proto, "NEXUS_PROTOCOL=%s", proto);
        char *env[] = { e_baud, e_par, e_db, e_sb, e_proto, NULL };
        ok = run_hook(slot, "configure", env) == 0;
        err = ok ? "" : "hook failed (see logread)";
    }
    (void)v;
    json_esc(v, sizeof v, err);
    snprintf(reply, sizeof reply, "{\"type\":\"configure_result\",\"slot\":%d,\"ok\":%s,\"error\":\"%s\"}\n",
             slot + 1, ok ? "true" : "false", v);
    cli_send(c, reply);
}

static void send_snapshot(cli_t *c) {
    char msg[OUTMAX];
    for (int i = 0; i < NSLOTS; i++) {
        fmt_module(msg, sizeof msg, i);
        cli_send(c, msg);
        if (c->fd < 0) return;
    }
    if (last_sys[0]) cli_send(c, last_sys);
}

static void handle_line(cli_t *c, const char *line) {
    char cmd[32];
    if (!json_get(line, "cmd", cmd, sizeof cmd)) return;
    if (!strcmp(cmd, "snapshot")) send_snapshot(c);
    else if (!strcmp(cmd, "rescan")) scan_slots(1);
    else if (!strcmp(cmd, "configure")) cmd_configure(c, line);
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
    for (int i = 0; i < NSLOTS; i++) { slots[i].cur = K_UNKNOWN; slots[i].pending = K_UNKNOWN; }
    for (int i = 0; i < MAXCLI; i++) clients[i].fd = -1;

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    int lfd = listen_socket();
    if (lfd < 0) { logf_("cannot listen on %s: %s", cfg.sock, strerror(errno)); return 1; }
    logf_("started: socket %s, period %ds, adc0 %s, adc1 %s", cfg.sock, cfg.period, cfg.adc_path[0], cfg.adc_path[1]);

    long long next = mono_ms(); /* first tick immediately */
    while (running) {
        long long now = mono_ms();
        if (now >= next) {
            scan_slots(0);
            fmt_system(last_sys, sizeof last_sys);
            broadcast(last_sys);
            next += (long long)cfg.period * 1000;
            if (next < now) next = now + (long long)cfg.period * 1000;
            now = mono_ms();
        }
        struct pollfd pfd[MAXCLI + 1];
        int idx[MAXCLI + 1], n = 0;
        pfd[n].fd = lfd; pfd[n].events = POLLIN; idx[n] = -1; n++;
        for (int i = 0; i < MAXCLI; i++)
            if (clients[i].fd >= 0) { pfd[n].fd = clients[i].fd; pfd[n].events = POLLIN; idx[n] = i; n++; }
        long long wait = next - now;
        if (wait < 0) wait = 0;
        int pr = poll(pfd, (nfds_t)n, (int)wait);
        if (pr <= 0) continue;
        for (int j = 0; j < n; j++) {
            if (!(pfd[j].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            if (idx[j] < 0) {
                int cfd = accept(lfd, NULL, NULL);
                if (cfd < 0) continue;
                int slot = -1;
                for (int i = 0; i < MAXCLI; i++) if (clients[i].fd < 0) { slot = i; break; }
                if (slot < 0) { close(cfd); continue; }
                clients[slot].fd = cfd;
                clients[slot].len = 0;
                send_snapshot(&clients[slot]);
            } else {
                cli_read(&clients[idx[j]]);
            }
        }
    }
    for (int i = 0; i < MAXCLI; i++) cli_close(&clients[i]);
    close(lfd);
    unlink(cfg.sock);
    logf_("stopped");
    return 0;
}
