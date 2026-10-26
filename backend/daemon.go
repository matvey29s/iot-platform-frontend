package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// DaemonClient keeps a connection to nexusd (unix socket, JSON lines) and
// reconnects forever.
//
//	nexusd -> backend: module / relay / button / led / rs485 / system + *_result
//	backend -> nexusd: configure / led / relay / rs485_tx
type DaemonClient struct {
	path  string
	store *Store

	mu      sync.Mutex // guards conn and waiters
	conn    net.Conn
	waiters map[string]chan cmdResult
	reqMu   sync.Mutex // one command in flight at a time (results are matched by type+key)
}

type cmdResult struct {
	OK    bool
	Error string
}

func NewDaemonClient(path string, st *Store) *DaemonClient {
	return &DaemonClient{path: path, store: st, waiters: map[string]chan cmdResult{}}
}

type daemonMsg struct {
	Type string `json:"type"`
	TS   int64  `json:"ts"`
	Slot int    `json:"slot"`
	N    int    `json:"n"`
	// module
	Module  string  `json:"module"`
	Raw     int64   `json:"raw"`
	Percent float64 `json:"percent"`
	AdcOk   bool    `json:"adcOk"`
	// relay
	States []int `json:"states"`
	// button / led
	Pressed bool `json:"pressed"`
	On      bool `json:"on"`
	// rs485
	Dir string `json:"dir"`
	Hex string `json:"hex"`
	// system
	Linux       string  `json:"linux"`
	CPUModel    string  `json:"cpuModel"`
	CPU         float64 `json:"cpu"`
	RAMTotalMb  float64 `json:"ramTotalMb"`
	RAMUsedMb   float64 `json:"ramUsedMb"`
	Uptime      float64 `json:"uptime"`
	DiskTotalMb float64 `json:"diskTotalMb"`
	DiskUsedMb  float64 `json:"diskUsedMb"`
	// *_result
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
	case "relay":
		d.store.UpdateRelay(m.Slot, m.States)
	case "button":
		d.store.UpdateButton(m.N, m.Pressed, m.TS)
	case "led":
		d.store.UpdateLed(m.N, m.On)
	case "rs485":
		if raw, err := hex.DecodeString(m.Hex); err == nil {
			d.store.AddRS485(m.Slot, m.Dir, raw, m.TS)
		}
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
	case "configure_result", "relay_result", "rs485_tx_result":
		d.deliver(fmt.Sprintf("%s:%d", m.Type, m.Slot), cmdResult{m.OK, m.Error})
	case "led_result":
		d.deliver(fmt.Sprintf("%s:%d", m.Type, m.Slot), cmdResult{m.OK, m.Error}) // slot field carries the led number
	}
}

func (d *DaemonClient) deliver(key string, r cmdResult) {
	d.mu.Lock()
	ch := d.waiters[key]
	d.mu.Unlock()
	if ch != nil {
		select {
		case ch <- r:
		default:
		}
	}
}

var errNoDaemon = errors.New("daemon не запущен")

func (d *DaemonClient) write(v any) error {
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

// request sends a command and waits for "<resultType>" with the given key.
func (d *DaemonClient) request(cmd map[string]any, resultType string, key int, timeout time.Duration) error {
	d.reqMu.Lock()
	defer d.reqMu.Unlock()
	wk := fmt.Sprintf("%s:%d", resultType, key)
	ch := make(chan cmdResult, 1)
	d.mu.Lock()
	d.waiters[wk] = ch
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.waiters, wk)
		d.mu.Unlock()
	}()
	if err := d.write(cmd); err != nil {
		return err
	}
	select {
	case r := <-ch:
		if !r.OK {
			return errors.New(r.Error)
		}
		return nil
	case <-time.After(timeout):
		return errors.New("daemon не ответил")
	}
}

// ConfigureRS485 applies baud/parity/bits to the slot's UART.
func (d *DaemonClient) ConfigureRS485(slot int, c Rs485Config) error {
	return d.request(map[string]any{
		"cmd": "configure", "slot": slot, "baud": c.BaudRate, "parity": c.Parity,
		"databits": c.DataBits, "stopbits": c.StopBits, "protocol": c.Protocol,
	}, "configure_result", slot, 8*time.Second)
}

func (d *DaemonClient) SetLed(n int, on bool) error {
	return d.request(map[string]any{"cmd": "led", "n": n, "on": on}, "led_result", n, 4*time.Second)
}

func (d *DaemonClient) SetRelay(slot, ch int, on bool) error {
	return d.request(map[string]any{"cmd": "relay", "slot": slot, "ch": ch, "on": on}, "relay_result", slot, 4*time.Second)
}

func (d *DaemonClient) RS485Send(slot int, data []byte) error {
	return d.request(map[string]any{"cmd": "rs485_tx", "slot": slot, "hex": hex.EncodeToString(data)}, "rs485_tx_result", slot, 6*time.Second)
}

func (d *DaemonClient) Rescan() error { return d.write(map[string]string{"cmd": "rescan"}) }
