package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ---- JSON shapes shared with the frontend (src/api/types.ts) -------------

type SlotState struct {
	Slot         int     `json:"slot"`
	Connected    bool    `json:"connected"`
	DetectedType *string `json:"detectedType"` // "rs485" | "relay" | null
	AdcPercent   float64 `json:"adcPercent"`
	AdcRaw       int64   `json:"adcRaw"`
	AdcOk        bool    `json:"adcOk"`
}

type PortState struct {
	ID           string      `json:"id"`
	Kind         string      `json:"kind"` // fixed | link | module
	Connected    bool        `json:"connected"`
	DetectedType *string     `json:"detectedType,omitempty"`
	Slots        []SlotState `json:"slots,omitempty"`
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

// History: 15 min at the 3 s sampling period.
const maxHistory = 300

// ---- persisted data (module settings, register tables, scenarios) --------

type persisted struct {
	ModuleConfigs map[string]json.RawMessage `json:"moduleConfigs"`
	Registers     map[string]json.RawMessage `json:"registers"`
	Scenarios     map[string]json.RawMessage `json:"scenarios"`
}

type Store struct {
	mu       sync.RWMutex
	cfg      Config
	daemonUp bool
	slots    [2]SlotState
	system   *SystemInfo
	history  []SystemSample
	links    map[string]bool // ethernet1/2, usb, sdcard... detected by backend
	data     persisted
	hub      *Hub
}

func NewStore(cfg Config, hub *Hub) *Store {
	s := &Store{cfg: cfg, hub: hub, links: map[string]bool{}}
	s.data = persisted{
		ModuleConfigs: map[string]json.RawMessage{},
		Registers:     map[string]json.RawMessage{},
		Scenarios:     map[string]json.RawMessage{},
	}
	for i := range s.slots {
		s.slots[i].Slot = i + 1
	}
	s.load()
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

// ---- views ------------------------------------------------------------------

func (s *Store) modulesPortLocked() PortState {
	p := PortState{ID: "modules", Kind: "module", Slots: append([]SlotState(nil), s.slots[:]...)}
	for _, sl := range s.slots {
		if sl.Connected {
			p.Connected = true
		}
	}
	return p
}

func (s *Store) ModulesPort() PortState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.modulesPortLocked()
}

func (s *Store) Ports() []PortState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	mk := func(id, kind string) PortState { return PortState{ID: id, Kind: kind, Connected: s.links[id]} }
	return []PortState{
		{ID: "power", Kind: "fixed", Connected: true}, // we are running, so it is powered
		mk("ethernet1", "link"), mk("ethernet2", "link"),
		mk("usb", "fixed"), mk("audioIn", "fixed"), mk("audioOut", "fixed"),
		mk("sdcard", "fixed"),
		{ID: "lcd", Kind: "fixed", Connected: true},
		s.modulesPortLocked(),
	}
}

func (s *Store) System() (SystemInfo, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.daemonUp || s.system == nil {
		return SystemInfo{}, false
	}
	return *s.system, true
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
	if slot < 1 || slot > 2 {
		return "", false
	}
	sl := s.slots[slot-1]
	if !sl.Connected || sl.DetectedType == nil {
		return "", false
	}
	return *sl.DetectedType, true
}

// ---- updates coming from the daemon / pollers --------------------------------

func (s *Store) SetDaemonUp(up bool) {
	s.mu.Lock()
	changed := s.daemonUp != up
	s.daemonUp = up
	if !up {
		for i := range s.slots {
			s.slots[i] = SlotState{Slot: i + 1}
		}
	}
	p := s.modulesPortLocked()
	s.mu.Unlock()
	if changed {
		s.hub.Publish("port_state", p)
	}
}

func (s *Store) UpdateSlot(slot int, module string, raw int64, pct float64, adcOk bool) {
	if slot < 1 || slot > 2 {
		return
	}
	s.mu.Lock()
	sl := &s.slots[slot-1]
	old := *sl
	sl.Slot = slot
	sl.AdcRaw, sl.AdcPercent, sl.AdcOk = raw, pct, adcOk
	if module == "rs485" || module == "relay" {
		m := module
		sl.Connected, sl.DetectedType = true, &m
	} else {
		sl.Connected, sl.DetectedType = false, nil
	}
	typeChanged := old.Connected != sl.Connected || (old.DetectedType == nil) != (sl.DetectedType == nil) ||
		(old.DetectedType != nil && sl.DetectedType != nil && *old.DetectedType != *sl.DetectedType)
	p := s.modulesPortLocked()
	s.mu.Unlock()
	if typeChanged {
		s.hub.Publish("port_state", p)
	}
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

func (s *Store) SetLink(id string, up bool) {
	s.mu.Lock()
	old, seen := s.links[id]
	s.links[id] = up
	s.mu.Unlock()
	if !seen || old != up {
		s.hub.Publish("port_state", PortState{ID: id, Kind: kindOf(id), Connected: up})
	}
}

func kindOf(id string) string {
	if id == "ethernet1" || id == "ethernet2" {
		return "link"
	}
	return "fixed"
}
