package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Rs485Config struct {
	BaudRate   int    `json:"baudRate"`
	Parity     string `json:"parity"`
	DataBits   int    `json:"dataBits"`
	StopBits   int    `json:"stopBits"`
	DevicePath string `json:"devicePath"`
	Protocol   string `json:"protocol"`
}

type RelayConfig struct {
	Channels  int    `json:"channels"`
	SafeState string `json:"safeState"`
}

type API struct {
	st  *Store
	dc  *DaemonClient
	en  *Engine
	hub *Hub
	cfg Config
}

func (a *API) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("GET /api/ports", a.ports)
	mux.HandleFunc("GET /api/system", a.system)
	mux.HandleFunc("GET /api/system/history", a.history)
	mux.HandleFunc("GET /api/modules/{id}/config", a.getModuleConfig)
	mux.HandleFunc("PUT /api/modules/{id}/config", a.putModuleConfig)
	mux.HandleFunc("GET /api/modules/{id}/registers", a.getRegisters)
	mux.HandleFunc("PUT /api/modules/{id}/registers", a.putRegisters)
	mux.HandleFunc("GET /api/scenarios", a.listScenarios)
	mux.HandleFunc("PUT /api/scenarios/{id}", a.putScenario)
	mux.HandleFunc("POST /api/scenarios/{id}/start", a.startScenario)
	mux.HandleFunc("POST /api/scenarios/{id}/stop", a.stopScenario)
	mux.HandleFunc("GET /api/scenarios/status", a.scenarioStatus)
	mux.HandleFunc("GET /api/io", a.io)
	mux.HandleFunc("POST /api/io/led/{n}/test", a.ledTest)
	mux.HandleFunc("GET /api/variables", a.listVars)
	mux.HandleFunc("PUT /api/variables", a.putVar)
	mux.HandleFunc("DELETE /api/variables", a.deleteVar)
	mux.HandleFunc("POST /api/variables/set", a.setVar)
	mux.HandleFunc("GET /api/time", a.getTime)
	mux.HandleFunc("POST /api/time", a.setTime)
	mux.HandleFunc("GET /api/ethernet", a.ethernet)
	mux.HandleFunc("POST /api/modules/{id}/relay", a.relaySet)
	mux.HandleFunc("GET /api/rs485/{slot}/log", a.rs485Log)
	mux.HandleFunc("POST /api/rs485/{slot}/send", a.rs485Send)
	mux.Handle("GET /api/events", a.hub)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown endpoint"})
	})
	mux.Handle("/", staticHandler(a.cfg.WWW))
	return mux
}

func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// index.html must always be revalidated so an update is picked up at once;
		// the hashed files under /assets never change and may be cached.
		if !strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fs.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, 4<<20))
}

// slotFromID: "module1" -> 1
func slotFromID(id string) int {
	if !strings.HasPrefix(id, "module") {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimPrefix(id, "module"))
	if err != nil || n < 1 || n > 2 {
		return 0
	}
	return n
}

// ---- handlers -----------------------------------------------------------------

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
	// PLACEHOLDER until real user management exists (the UI currently auto-logs in).
	if in.Username == "admin" && in.Password == "admin" {
		tok := make([]byte, 16)
		rand.Read(tok)
		writeJSON(w, 200, map[string]any{"ok": true, "token": hex.EncodeToString(tok), "mustChangePassword": false})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": false, "error": "Неверный логин или пароль"})
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	_, up := a.st.System()
	writeJSON(w, 200, map[string]any{"ok": true, "daemon": up})
}

func (a *API) ports(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.st.Ports()) }

func (a *API) system(w http.ResponseWriter, r *http.Request) {
	si, ok := a.st.System()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "нет связи с daemon (nexusd)"})
		return
	}
	writeJSON(w, 200, si)
}

func (a *API) history(w http.ResponseWriter, r *http.Request) {
	m, _ := strconv.Atoi(r.URL.Query().Get("minutes"))
	if m < 1 || m > 15 {
		m = 15
	}
	writeJSON(w, 200, a.st.History(m))
}

func (a *API) defaultConfig(id string) (any, bool) {
	slot := slotFromID(id)
	typ, ok := a.st.SlotType(slot)
	if !ok {
		return nil, false
	}
	if typ == "rs485" {
		return Rs485Config{9600, "none", 8, 1, a.cfg.UartDev[slot-1], "modbus_rtu"}, true
	}
	return RelayConfig{1, "all_off"}, true
}

func (a *API) getModuleConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.st.mu.RLock()
	raw, ok := a.st.data.ModuleConfigs[id]
	a.st.mu.RUnlock()
	// A stored config belongs to the module that used to stand in this slot. After the modules were swapped it has
	// the wrong shape (a relay config for an RS-485 module and vice versa): ignore it and use the defaults.
	if ok {
		typ, _ := a.st.SlotType(slotFromID(id))
		switch typ {
		case "rs485":
			var c Rs485Config
			if json.Unmarshal(raw, &c) == nil && c.BaudRate >= 1200 && c.Protocol != "" {
				c.DevicePath = a.cfg.UartDev[slotFromID(id)-1] // always the real device of this slot
				writeJSON(w, 200, c)
				return
			}
		case "relay":
			var c RelayConfig
			if json.Unmarshal(raw, &c) == nil && c.Channels == 1 && c.SafeState != "" {
				writeJSON(w, 200, c)
				return
			}
		}
	}
	if def, ok := a.defaultConfig(id); ok {
		writeJSON(w, 200, def)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("null"))
}

func (a *API) putModuleConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	slot := slotFromID(id)
	typ, ok := a.st.SlotType(slot)
	if !ok {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "Модуль не обнаружен в данном слоте"})
		return
	}
	body, err := readBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad body"})
		return
	}
	var store any
	var applyErr error
	switch typ {
	case "rs485":
		c := Rs485Config{9600, "none", 8, 1, "", "modbus_rtu"} // fields the client leaves out keep their defaults
		if json.Unmarshal(body, &c) != nil || c.BaudRate < 1200 || c.BaudRate > 921600 ||
			(c.Parity != "none" && c.Parity != "even" && c.Parity != "odd") ||
			(c.DataBits != 7 && c.DataBits != 8) || (c.StopBits != 1 && c.StopBits != 2) ||
			(c.Protocol != "modbus_rtu" && c.Protocol != "modbus_ascii") {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "Недопустимые параметры порта"})
			return
		}
		c.DevicePath = a.cfg.UartDev[slot-1] // the device node is fixed by hardware, not user input
		applyErr = a.dc.ConfigureRS485(slot, c) // the values are kept even when applying fails: they are re-applied when the module appears
		store = c
	default:
		var c RelayConfig
		if json.Unmarshal(body, &c) != nil || c.Channels != 1 ||
			(c.SafeState != "keep" && c.SafeState != "all_off" && c.SafeState != "all_on") {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "Недопустимые параметры реле"})
			return
		}
		store = c
	}
	raw, _ := json.Marshal(store)
	a.st.mu.Lock()
	a.st.data.ModuleConfigs[id] = raw
	err = a.st.saveLocked()
	a.st.mu.Unlock()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "Не удалось сохранить: " + err.Error()})
		return
	}
	if applyErr != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "Значения сохранены, но не применены: " + applyErr.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) getRegisters(w http.ResponseWriter, r *http.Request) {
	a.st.mu.RLock()
	raw, ok := a.st.data.Registers[r.PathValue("id")]
	a.st.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	if !ok {
		w.Write([]byte("[]"))
		return
	}
	w.Write(raw)
}

func (a *API) putRegisters(w http.ResponseWriter, r *http.Request) {
	body, _ := readBody(r)
	var rows []json.RawMessage
	if json.Unmarshal(body, &rows) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad body"})
		return
	}
	a.st.mu.Lock()
	a.st.data.Registers[r.PathValue("id")] = body
	err := a.st.saveLocked()
	a.st.mu.Unlock()
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) listScenarios(w http.ResponseWriter, r *http.Request) {
	a.st.mu.RLock()
	out := make([]json.RawMessage, 0, len(a.st.data.Scenarios))
	for _, v := range a.st.data.Scenarios {
		out = append(out, v)
	}
	a.st.mu.RUnlock()
	writeJSON(w, 200, out)
}

func (a *API) putScenario(w http.ResponseWriter, r *http.Request) {
	body, _ := readBody(r)
	var probe struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &probe) != nil || probe.ID == "" || probe.ID != r.PathValue("id") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad scenario"})
		return
	}
	a.st.mu.Lock()
	a.st.data.Scenarios[probe.ID] = body
	err := a.st.saveLocked()
	a.st.mu.Unlock()
	a.st.SyncScenarioVars(body)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) startScenario(w http.ResponseWriter, r *http.Request) {
	if err := a.en.Start(r.PathValue("id")); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) stopScenario(w http.ResponseWriter, r *http.Request) {
	a.en.StopAndForget()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) scenarioStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, a.en.Status())
}

func (a *API) io(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.st.IO()) }

func (a *API) ethernet(w http.ResponseWriter, r *http.Request) {
	e, ok := a.st.Ethernet()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "нет данных от daemon"})
		return
	}
	writeJSON(w, 200, e)
}

// POST /api/modules/module1/relay {"on":true}  (the relay module has a single channel)
func (a *API) relaySet(w http.ResponseWriter, r *http.Request) {
	slot := slotFromID(r.PathValue("id"))
	var in struct{ On bool }
	body, _ := readBody(r)
	if slot == 0 || json.Unmarshal(body, &in) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad request"})
		return
	}
	if typ, ok := a.st.SlotType(slot); !ok || typ != "relay" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "В этом слоте нет модуля реле"})
		return
	}
	if a.en.Locked() {
		writeJSON(w, 200, map[string]any{"ok": false, "error": lockedMsg})
		return
	}
	if err := a.dc.SetRelay(slot, 1, in.On); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	a.st.SetManual(fmt.Sprintf("relay%d", slot), in.On)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *API) rs485Log(w http.ResponseWriter, r *http.Request) {
	slot, _ := strconv.Atoi(r.PathValue("slot"))
	log := a.st.Terminal(slot)
	if log == nil {
		log = []RS485Entry{}
	}
	writeJSON(w, 200, log)
}

// POST {mode:"text"|"hex", data:"...", eol:"none"|"cr"|"lf"|"crlf"}
func (a *API) rs485Send(w http.ResponseWriter, r *http.Request) {
	slot, _ := strconv.Atoi(r.PathValue("slot"))
	var in struct{ Mode, Data, Eol string }
	body, _ := readBody(r)
	if json.Unmarshal(body, &in) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad body"})
		return
	}
	if typ, ok := a.st.SlotType(slot); !ok || typ != "rs485" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "В этом слоте нет модуля RS-485"})
		return
	}
	var data []byte
	if in.Mode == "hex" {
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == ':' || r == '-' {
				return -1
			}
			return r
		}, in.Data)
		b, err := hex.DecodeString(clean)
		if err != nil || len(b) == 0 {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "Неверный HEX"})
			return
		}
		data = b
	} else {
		data = []byte(in.Data)
	}
	switch in.Eol {
	case "cr":
		data = append(data, '\r')
	case "lf":
		data = append(data, '\n')
	case "crlf":
		data = append(data, '\r', '\n')
	}
	if len(data) == 0 || len(data) > 512 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "Пустой кадр или длиннее 512 байт"})
		return
	}
	if err := a.dc.RS485Send(slot, data); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /api/io/led/2/test — the LED lights for one second (manual control, so not while a scenario runs)
func (a *API) ledTest(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.PathValue("n"))
	if n < 1 || n > nLeds {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad led"})
		return
	}
	if a.en.Locked() {
		writeJSON(w, 200, map[string]any{"ok": false, "error": lockedMsg})
		return
	}
	prev, _ := a.st.LedOn(n)
	if err := a.dc.SetLed(n, true); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	go func() {
		time.Sleep(time.Second)
		if !a.en.Locked() {
			_ = a.dc.SetLed(n, prev)
		}
	}()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/time -> the controller clock. The board may have no RTC battery and no internet, so the clock can be far off.
func (a *API) getTime(w http.ResponseWriter, r *http.Request) {
	_, err := os.Stat("/dev/rtc0")
	writeJSON(w, 200, map[string]any{"now": time.Now().UnixMilli(), "rtc": err == nil})
}

// POST /api/time {"ms": <epoch ms>} — set the system clock (and the RTC when there is one) from the browser's time.
func (a *API) setTime(w http.ResponseWriter, r *http.Request) {
	var in struct{ Ms int64 }
	body, _ := readBody(r)
	if json.Unmarshal(body, &in) != nil || in.Ms < 1_600_000_000_000 {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad time"})
		return
	}
	if out, err := exec.Command("date", "-u", "-s", "@"+strconv.FormatInt(in.Ms/1000, 10)).CombinedOutput(); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": strings.TrimSpace(string(out))})
		return
	}
	if _, err := os.Stat("/dev/rtc0"); err == nil {
		_ = exec.Command("hwclock", "-w", "-u").Run()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "now": time.Now().UnixMilli()})
}

// applyStoredConfig sends the saved RS-485 port settings to a module that has just appeared (after a reboot or a swap).
func (a *API) applyStoredConfig(slot int, typ string) {
	if typ != "rs485" {
		return
	}
	time.Sleep(800 * time.Millisecond) // the daemon opens the UART right after it announces the module
	a.st.mu.RLock()
	raw, ok := a.st.data.ModuleConfigs[moduleID(slot)]
	a.st.mu.RUnlock()
	var c Rs485Config
	if !ok || json.Unmarshal(raw, &c) != nil || c.BaudRate < 1200 || c.Protocol == "" {
		return
	}
	if err := a.dc.ConfigureRS485(slot, c); err != nil {
		log.Printf("slot %d: cannot re-apply saved RS-485 settings: %v", slot, err)
	}
}
