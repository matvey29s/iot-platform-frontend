package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ---- JSON shapes shared with the frontend (src/api/types.ts) -------------

type PortState struct {
	ID           string  `json:"id"`
	Name         string  `json:"name,omitempty"` // modules: RS485-0, Relay-0, ...
	Kind         string  `json:"kind"`           // fixed | link | module
	Connected    bool    `json:"connected"`
	Slot         int     `json:"slot,omitempty"`
	DetectedType *string `json:"detectedType,omitempty"` // modules: "rs485" | "relay"
	AdcPercent   float64 `json:"adcPercent,omitempty"`
	AdcRaw       int64   `json:"adcRaw,omitempty"`
	AdcOk        bool    `json:"adcOk,omitempty"`
	Relays       []bool  `json:"relays,omitempty"` // relay module: channel states
}

// EthInfo is what the daemon reports about the Ethernet interface (right-click on "ethernet1").
type EthInfo struct {
	Iface     string `json:"iface"`
	Exists    bool   `json:"exists"`
	Up        bool   `json:"up"` // carrier
	Operstate string `json:"operstate"`
	Speed     int64  `json:"speed"` // Mbit/s, -1 = unknown
	Duplex    string `json:"duplex"`
	Mac       string `json:"mac"`
	IP        string `json:"ip"`
	Mask      string `json:"mask"`
	MTU       int64  `json:"mtu"`
	RxBytes   int64  `json:"rxBytes"`
	TxBytes   int64  `json:"txBytes"`
	RxPackets int64  `json:"rxPackets"`
	TxPackets int64  `json:"txPackets"`
	RxErrors  int64  `json:"rxErrors"`
	TxErrors  int64  `json:"txErrors"`
	RxDropped int64  `json:"rxDropped"`
	TxDropped int64  `json:"txDropped"`
	RxRate    int64  `json:"rxRate"` // bytes/s
	TxRate    int64  `json:"txRate"`
	TS        int64  `json:"ts"`
}

type LedState struct {
	N  int  `json:"n"` // 1..3 (programmable LEDs)
	On bool `json:"on"`
}

type ButtonState struct {
	N             int   `json:"n"` // 1..3 (programmable buttons)
	Pressed       bool  `json:"pressed"`
	LastPressedAt int64 `json:"lastPressedAt"` // epoch ms, 0 = never
}

type IOState struct {
	Leds    []LedState    `json:"leds"`
	Buttons []ButtonState `json:"buttons"`
}

type RS485Entry struct {
	Slot int    `json:"slot"`
	Dir  string `json:"dir"` // rx | tx
	Hex  string `json:"hex"`
	Text string `json:"text"`
	TS   int64  `json:"ts"`
}

type SystemInfo struct {
	SampledAt       int64   `json:"sampledAt"`
	LinuxVersion    string  `json:"linuxVersion"`
	CPUModel        string  `json:"cpuModel"`
	CPUUsagePercent float64 `json:"cpuUsagePercent"`
	RAMTotalMb      float64 `json:"ramTotalMb"`
	RAMUsedMb       float64 `json:"ramUsedMb"`
	UptimeSeconds   float64 `json:"uptimeSeconds"`
	DiskTotalMb     float64 `json:"diskTotalMb"`
	DiskUsedMb      float64 `json:"diskUsedMb"`
}

type SystemSample struct {
	SampledAt       int64   `json:"sampledAt"`
	CPUUsagePercent float64 `json:"cpuUsagePercent"`
	RAMUsedMb       float64 `json:"ramUsedMb"`
	RAMTotalMb      float64 `json:"ramTotalMb"`
}

const (
	maxHistory = 300 // 15 min at the 3 s sampling period
	maxRS485   = 300 // terminal lines kept per slot
	nSlots     = 2
	nLeds      = 3
	nButtons   = 3
	nRelays    = 1 // a relay module has a single channel
)

// ---- persisted data (module settings, register tables, scenarios) --------

type persisted struct {
	ModuleConfigs map[string]json.RawMessage `json:"moduleConfigs"`
	Registers     map[string]json.RawMessage `json:"registers"`
	Scenarios     map[string]json.RawMessage `json:"scenarios"`
	LastPressed   map[string]int64           `json:"lastPressed"`
	Running       string                     `json:"running"` // scenario to resume after a reboot
}

type slotInfo struct {
	connected bool
	typ       string
	pct       float64
	raw       int64
	adcOk     bool
	relays    [nRelays]bool
}

type Store struct {
	mu       sync.RWMutex
	cfg      Config
	daemonUp bool
	slots    [nSlots]slotInfo
	leds     [nLeds]bool
	buttons  [nButtons]bool
	system   *SystemInfo
	history  []SystemSample
	links    map[string]bool
	eth      *EthInfo
	term     [nSlots][]RS485Entry
	data     persisted
	dirty    bool
	hub      *Hub
}

func NewStore(cfg Config, hub *Hub) *Store {
	s := &Store{cfg: cfg, hub: hub, links: map[string]bool{}}
	s.data = persisted{
		ModuleConfigs: map[string]json.RawMessage{},
		Registers:     map[string]json.RawMessage{},
		Scenarios:     map[string]json.RawMessage{},
		LastPressed:   map[string]int64{},
	}
	s.load()
	go func() { // last-press times are flushed lazily so a button does not wear the flash
		for range time.Tick(30 * time.Second) {
			s.mu.Lock()
			if s.dirty {
				s.dirty = false
				_ = s.saveLocked()
			}
			s.mu.Unlock()
		}
	}()
	return s
}

func (s *Store) file() string { return filepath.Join(s.cfg.DataDir, "state.json") }

func (s *Store) load() {
	b, err := os.ReadFile(s.file())
	if err != nil {
		return
	}
	var p persisted
	if json.Unmarshal(b, &p) != nil {
		return
	}
	if p.ModuleConfigs != nil {
		s.data.ModuleConfigs = p.ModuleConfigs
	}
	if p.Registers != nil {
		s.data.Registers = p.Registers
	}
	if p.Scenarios != nil {
		s.data.Scenarios = p.Scenarios
	}
	if p.LastPressed != nil {
		s.data.LastPressed = p.LastPressed
	}
	s.data.Running = p.Running
}

// saveLocked writes atomically (tmp + rename) so a power cut cannot leave a
// half-written file. Caller holds s.mu.
func (s *Store) saveLocked() error {
	if err := os.MkdirAll(s.cfg.DataDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file())
}

func (s *Store) SetRunning(id string) {
	s.mu.Lock()
	s.data.Running = id
	_ = s.saveLocked()
	s.mu.Unlock()
}

func (s *Store) RunningID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data.Running
}

func (s *Store) Scenario(id string) (json.RawMessage, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	raw, ok := s.data.Scenarios[id]
	return raw, ok
}

// ---- views ------------------------------------------------------------------

// moduleNamesLocked: connected modules are named per type in slot order: RS485-0, RS485-1, Relay-0, ...
func (s *Store) moduleNamesLocked() [nSlots]string {
	var names [nSlots]string
	count := map[string]int{}
	for i, sl := range s.slots {
		if !sl.connected {
			continue
		}
		base := "RS485"
		if sl.typ == "relay" {
			base = "Relay"
		}
		names[i] = fmt.Sprintf("%s-%d", base, count[base])
		count[base]++
	}
	return names
}

// ModuleName returns "" for an empty slot.
func (s *Store) ModuleName(slot int) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if slot < 1 || slot > nSlots {
		return ""
	}
	return s.moduleNamesLocked()[slot-1]
}

// SlotByName: "RS485-0" / "relay-0" -> slot number, 0 when no such module is connected.
func (s *Store) SlotByName(name string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i, n := range s.moduleNamesLocked() {
		if n != "" && strings.EqualFold(n, strings.TrimSpace(name)) {
			return i + 1
		}
	}
	return 0
}

func moduleID(slot int) string { return "module" + string(rune('0'+slot)) }

func (s *Store) modulePortLocked(i int) PortState {
	sl := s.slots[i]
	p := PortState{ID: moduleID(i + 1), Kind: "module", Slot: i + 1, Connected: sl.connected,
		AdcPercent: sl.pct, AdcRaw: sl.raw, AdcOk: sl.adcOk}
	p.Name = s.moduleNamesLocked()[i]
	if sl.connected {
		t := sl.typ
		p.DetectedType = &t
		if t == "relay" {
			p.Relays = append([]bool(nil), sl.relays[:]...)
		}
	}
	return p
}

func (s *Store) ModulePort(slot int) PortState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.modulePortLocked(slot - 1)
}

func (s *Store) Ports() []PortState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return []PortState{
		{ID: "power", Kind: "fixed", Connected: true}, // we are running, so it is powered
		{ID: "ethernet1", Kind: "link", Connected: s.links["ethernet1"]},
		{ID: "sdcard", Kind: "fixed", Connected: s.links["sdcard"]},
		s.modulePortLocked(0),
		s.modulePortLocked(1),
	}
}

func (s *Store) IO() IOState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := IOState{}
	for i := 0; i < nLeds; i++ {
		out.Leds = append(out.Leds, LedState{N: i + 1, On: s.leds[i]})
	}
	for i := 0; i < nButtons; i++ {
		out.Buttons = append(out.Buttons, ButtonState{N: i + 1, Pressed: s.buttons[i], LastPressedAt: s.data.LastPressed[itoa(i+1)]})
	}
	return out
}

func itoa(n int) string { return string(rune('0' + n)) }

func (s *Store) System() (SystemInfo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.daemonUp || s.system == nil {
		return SystemInfo{}, false
	}
	return *s.system, true
}

func (s *Store) DaemonUp() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.daemonUp
}

func (s *Store) History(minutes int) []SystemSample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cut := time.Now().Add(-time.Duration(minutes) * time.Minute).UnixMilli()
	out := []SystemSample{}
	for _, h := range s.history {
		if h.SampledAt >= cut {
			out = append(out, h)
		}
	}
	return out
}

func (s *Store) SlotType(slot int) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if slot < 1 || slot > nSlots {
		return "", false
	}
	sl := s.slots[slot-1]
	return sl.typ, sl.connected
}

func (s *Store) Terminal(slot int) []RS485Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if slot < 1 || slot > nSlots {
		return nil
	}
	return append([]RS485Entry{}, s.term[slot-1]...)
}

// variable lookup for scenario conditions
func (s *Store) ButtonPressed(n int) (bool, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if n < 1 || n > nButtons {
		return false, false
	}
	return s.buttons[n-1], true
}
func (s *Store) LedOn(n int) (bool, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if n < 1 || n > nLeds {
		return false, false
	}
	return s.leds[n-1], true
}
func (s *Store) RelayOn(slot, ch int) (bool, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if slot < 1 || slot > nSlots || ch < 1 || ch > nRelays {
		return false, false
	}
	return s.slots[slot-1].relays[ch-1], true
}

// ---- updates coming from the daemon / pollers --------------------------------

func (s *Store) SetDaemonUp(up bool) {
	s.mu.Lock()
	changed := s.daemonUp != up
	s.daemonUp = up
	if !up {
		for i := range s.slots {
			s.slots[i] = slotInfo{}
		}
		s.eth = nil
		s.links["ethernet1"] = false
	}
	ports := []PortState{s.modulePortLocked(0), s.modulePortLocked(1), {ID: "ethernet1", Kind: "link", Connected: false}}
	s.mu.Unlock()
	if changed {
		for _, p := range ports {
			s.hub.Publish("port_state", p)
		}
	}
}

func (s *Store) UpdateSlot(slot int, module string, raw int64, pct float64, adcOk bool) {
	if slot < 1 || slot > nSlots {
		return
	}
	s.mu.Lock()
	sl := &s.slots[slot-1]
	old := *sl
	sl.raw, sl.pct, sl.adcOk = raw, pct, adcOk
	if module == "rs485" || module == "relay" {
		sl.connected, sl.typ = true, module
	} else {
		sl.connected, sl.typ = false, ""
		sl.relays = [nRelays]bool{}
	}
	changed := old.connected != sl.connected || old.typ != sl.typ || old.adcOk != sl.adcOk
	p := s.modulePortLocked(slot - 1)
	all := []PortState{s.modulePortLocked(0), s.modulePortLocked(1)}
	s.mu.Unlock()
	if changed {
		for _, q := range all { // names of the other slot can change too (RS485-0 -> RS485-1)
			s.hub.Publish("port_state", q)
		}
	} else {
		s.hub.Publish("port_adc", map[string]any{"id": p.ID, "adcPercent": pct, "adcRaw": raw})
	}
}

func (s *Store) UpdateRelay(slot int, states []int) {
	if slot < 1 || slot > nSlots {
		return
	}
	s.mu.Lock()
	sl := &s.slots[slot-1]
	for i := 0; i < nRelays && i < len(states); i++ {
		sl.relays[i] = states[i] != 0
	}
	p := s.modulePortLocked(slot - 1)
	s.mu.Unlock()
	s.hub.Publish("port_state", p)
}

func (s *Store) UpdateButton(n int, pressed bool, ts int64) {
	if n < 1 || n > nButtons {
		return
	}
	s.mu.Lock()
	s.buttons[n-1] = pressed
	if pressed {
		s.data.LastPressed[itoa(n)] = ts
		s.dirty = true
	}
	st := ButtonState{N: n, Pressed: pressed, LastPressedAt: s.data.LastPressed[itoa(n)]}
	s.mu.Unlock()
	s.hub.Publish("io_button", st)
}

func (s *Store) UpdateLed(n int, on bool) {
	if n < 1 || n > nLeds {
		return
	}
	s.mu.Lock()
	s.leds[n-1] = on
	s.mu.Unlock()
	s.hub.Publish("io_led", LedState{N: n, On: on})
}

func (s *Store) AddRS485(slot int, dir string, raw []byte, ts int64) {
	if slot < 1 || slot > nSlots {
		return
	}
	e := RS485Entry{Slot: slot, Dir: dir, Hex: hex.EncodeToString(raw), Text: printable(raw), TS: ts}
	s.mu.Lock()
	t := append(s.term[slot-1], e)
	if len(t) > maxRS485 {
		t = t[len(t)-maxRS485:]
	}
	s.term[slot-1] = t
	s.mu.Unlock()
	s.hub.Publish("rs485_data", e)
}

// printable: ASCII view of a frame, non-printable bytes shown as '.'
func printable(b []byte) string {
	out := make([]rune, 0, len(b))
	for _, c := range b {
		if c >= 0x20 && c < 0x7f {
			out = append(out, rune(c))
		} else {
			out = append(out, '.')
		}
	}
	if !utf8.ValidString(string(out)) {
		return ""
	}
	return string(out)
}

func (s *Store) UpdateSystem(si SystemInfo) {
	s.mu.Lock()
	s.system = &si
	s.history = append(s.history, SystemSample{si.SampledAt, si.CPUUsagePercent, si.RAMUsedMb, si.RAMTotalMb})
	if len(s.history) > maxHistory {
		s.history = s.history[len(s.history)-maxHistory:]
	}
	s.mu.Unlock()
	s.hub.Publish("system_info", si)
}

func (s *Store) UpdateEthernet(e EthInfo) {
	s.mu.Lock()
	s.eth = &e
	s.mu.Unlock()
	s.hub.Publish("ethernet", e)
	s.SetLink("ethernet1", e.Up)
}

func (s *Store) Ethernet() (EthInfo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.eth == nil {
		return EthInfo{}, false
	}
	return *s.eth, true
}

func (s *Store) SetLink(id string, up bool) {
	s.mu.Lock()
	old, seen := s.links[id]
	s.links[id] = up
	s.mu.Unlock()
	if !seen || old != up {
		kind := "fixed"
		if id == "ethernet1" {
			kind = "link"
		}
		s.hub.Publish("port_state", PortState{ID: id, Kind: kind, Connected: up})
	}
}
