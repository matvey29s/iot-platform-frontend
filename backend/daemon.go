package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net"
	"sync"
	"time"
)

// DaemonClient keeps a connection to nexusd (unix socket, JSON lines) and
// reconnects forever. nexusd -> backend: module / system / configure_result.
// backend -> nexusd: snapshot / rescan / configure.
type DaemonClient struct {
	path  string
	store *Store

	mu      sync.Mutex
	conn    net.Conn
	waiters map[int]chan cfgResult
}

type cfgResult struct {
	OK    bool
	Error string
}

func NewDaemonClient(path string, st *Store) *DaemonClient {
	return &DaemonClient{path: path, store: st, waiters: map[int]chan cfgResult{}}
}

type daemonMsg struct {
	Type string `json:"type"`
	TS   int64  `json:"ts"`
	// module
	Slot    int     `json:"slot"`
	Module  string  `json:"module"`
	Raw     int64   `json:"raw"`
	Percent float64 `json:"percent"`
	AdcOk   bool    `json:"adcOk"`
	// system
	Linux       string  `json:"linux"`
	CPUModel    string  `json:"cpuModel"`
	CPU         float64 `json:"cpu"`
	RAMTotalMb  float64 `json:"ramTotalMb"`
	RAMUsedMb   float64 `json:"ramUsedMb"`
	Uptime      float64 `json:"uptime"`
	DiskTotalMb float64 `json:"diskTotalMb"`
	DiskUsedMb  float64 `json:"diskUsedMb"`
	// configure_result
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

func (d *DaemonClient) Run() {
	for {
		conn, err := net.Dial("unix", d.path)
		if err != nil {
			d.store.SetDaemonUp(false)
			time.Sleep(2 * time.Second)
			continue
		}
		log.Printf("connected to nexusd at %s", d.path)
		d.mu.Lock()
		d.conn = conn
		d.mu.Unlock()
		d.store.SetDaemonUp(true)

		sc := bufio.NewScanner(conn)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			var m daemonMsg
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			d.handle(m)
		}
		log.Printf("nexusd connection lost: %v", sc.Err())
		d.mu.Lock()
		d.conn = nil
		d.mu.Unlock()
		conn.Close()
		d.store.SetDaemonUp(false)
		time.Sleep(time.Second)
	}
}

func (d *DaemonClient) handle(m daemonMsg) {
	switch m.Type {
	case "module":
		d.store.UpdateSlot(m.Slot, m.Module, m.Raw, m.Percent, m.AdcOk)
	case "system":
		ts := m.TS
		if ts == 0 {
			ts = time.Now().UnixMilli()
		}
		d.store.UpdateSystem(SystemInfo{
			SampledAt: ts, LinuxVersion: m.Linux, CPUModel: m.CPUModel, CPUUsagePercent: m.CPU,
			RAMTotalMb: m.RAMTotalMb, RAMUsedMb: m.RAMUsedMb, UptimeSeconds: m.Uptime,
			DiskTotalMb: m.DiskTotalMb, DiskUsedMb: m.DiskUsedMb,
		})
	case "configure_result":
		d.mu.Lock()
		ch := d.waiters[m.Slot]
		d.mu.Unlock()
		if ch != nil {
			select {
			case ch <- cfgResult{m.OK, m.Error}:
			default:
			}
		}
	}
}

var errNoDaemon = errors.New("daemon не запущен")

func (d *DaemonClient) send(v any) error {
	b, _ := json.Marshal(v)
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conn == nil {
		return errNoDaemon
	}
	d.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := d.conn.Write(append(b, '\n'))
	return err
}

// ConfigureRS485 asks the daemon to apply UART parameters (hook script) and
// waits for its answer.
func (d *DaemonClient) ConfigureRS485(slot int, c Rs485Config) error {
	ch := make(chan cfgResult, 1)
	d.mu.Lock()
	d.waiters[slot] = ch
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.waiters, slot)
		d.mu.Unlock()
	}()
	err := d.send(map[string]any{
		"cmd": "configure", "slot": slot, "baud": c.BaudRate, "parity": c.Parity,
		"databits": c.DataBits, "stopbits": c.StopBits, "protocol": c.Protocol,
	})
	if err != nil {
		return err
	}
	select {
	case r := <-ch:
		if !r.OK {
			return errors.New(r.Error)
		}
		return nil
	case <-time.After(8 * time.Second):
		return errors.New("daemon не ответил")
	}
}

func (d *DaemonClient) Rescan() error { return d.send(map[string]string{"cmd": "rescan"}) }
