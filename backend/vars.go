package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// Variables: hardware ones (BTN-n, LED-n, Relay-n) are computed from the live state; the rest live in a registry
// (custom ones added by the user and the ones created by "RS-485: Parse" rows) and keep their runtime value in Store.rt.

type VarDef struct {
	Name        string `json:"name"`
	Format      string `json:"format"` // bool | int | float | string
	Description string `json:"description"`
	Source      string `json:"source"` // custom | rs485 | builtin (builtin = only a description of a hardware variable)
}

type rtVal struct {
	F float64
	S string
}

type VarView struct {
	Name        string `json:"name"`
	Format      string `json:"format"`
	Description string `json:"description"`
	Source      string `json:"source"` // button | led | relay | rs485 | custom
	Value       any    `json:"value"`
	Writable    bool   `json:"writable"`
	Deletable   bool   `json:"deletable"`
}

func vkey(name string) string { return strings.ToUpper(strings.TrimSpace(name)) }

func formatOfType(dt string) string {
	switch dt {
	case "bool":
		return "bool"
	case "float32":
		return "float"
	case "text":
		return "string"
	}
	return "int"
}

func (s *Store) varDesc(name string) string {
	return s.data.Vars[vkey(name)].Description
}

func fromRT(format string, v rtVal) any {
	switch format {
	case "bool":
		return v.F != 0
	case "string":
		return v.S
	case "int":
		return int64(v.F)
	}
	return v.F
}

// Variables lists everything the user can see on the "Variables" tab.
func (s *Store) Variables() []VarView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []VarView{}
	for i := 1; i <= nButtons; i++ {
		n := fmt.Sprintf("BTN-%d", i)
		out = append(out, VarView{n, "bool", s.varDesc(n), "button", s.buttons[i-1], false, false})
	}
	for i := 1; i <= nLeds; i++ {
		n := fmt.Sprintf("LED-%d", i)
		out = append(out, VarView{n, "bool", s.varDesc(n), "led", s.leds[i-1], true, false})
	}
	for i, nm := range s.moduleNamesLocked() {
		if nm != "" && s.slots[i].typ == "relay" {
			out = append(out, VarView{nm, "bool", s.varDesc(nm), "relay", s.slots[i].relays[0], true, false})
		}
	}
	keys := make([]string, 0, len(s.data.Vars))
	for k, v := range s.data.Vars {
		if v.Source != "builtin" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		d := s.data.Vars[k]
		out = append(out, VarView{d.Name, d.Format, d.Description, d.Source, fromRT(d.Format, s.rt[k]), true, true})
	}
	return out
}

// VarGet returns the numeric value of any variable (for conditions and payloads).
func (s *Store) VarGet(name string) (float64, bool) {
	k := vkey(name)
	b2f := func(v bool) float64 {
		if v {
			return 1
		}
		return 0
	}
	switch {
	case strings.HasPrefix(k, "BTN-"):
		if n, err := strconv.Atoi(k[4:]); err == nil {
			if v, ok := s.ButtonPressed(n); ok {
				return b2f(v), true
			}
		}
	case strings.HasPrefix(k, "LED-"):
		if n, err := strconv.Atoi(k[4:]); err == nil {
			if v, ok := s.LedOn(n); ok {
				return b2f(v), true
			}
		}
	case strings.HasPrefix(k, "RELAY-"):
		if slot := s.SlotByName(k); slot > 0 {
			if v, ok := s.RelayOn(slot, 1); ok {
				return b2f(v), true
			}
		}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.rt[k]
	if ok {
		if d, has := s.data.Vars[k]; has && d.Format == "string" {
			f, err := strconv.ParseFloat(strings.Replace(v.S, ",", ".", 1), 64)
			return f, err == nil
		}
	}
	return v.F, ok
}

// VarSetRuntime writes a value produced by the scenario (RS-485 parse). The variable is registered if it is new.
func (s *Store) VarSetRuntime(name, format string, f float64) {
	k := vkey(name)
	s.mu.Lock()
	if _, ok := s.data.Vars[k]; !ok {
		s.data.Vars[k] = VarDef{Name: strings.TrimSpace(name), Format: format, Source: "rs485"}
	}
	s.rt[k] = rtVal{F: f}
	s.mu.Unlock()
	s.hub.Publish("variable", map[string]any{"name": strings.TrimSpace(name)})
}

// convert a text/number into the target format. Returns the stored value and whether information was lost.
func convertTo(format string, f float64, str string, fromFormat string) (rtVal, error) {
	switch format {
	case "bool":
		if fromFormat == "string" {
			switch strings.ToLower(strings.TrimSpace(str)) {
			case "1", "true", "вкл", "on":
				return rtVal{F: 1}, nil
			case "0", "false", "выкл", "off", "":
				return rtVal{F: 0}, nil
			}
			return rtVal{}, fmt.Errorf("«%s» нельзя преобразовать в bool", str)
		}
		if f != 0 {
			return rtVal{F: 1}, nil
		}
		return rtVal{F: 0}, nil
	case "int":
		if fromFormat == "string" {
			v, err := strconv.ParseFloat(strings.Replace(strings.TrimSpace(str), ",", ".", 1), 64)
			if err != nil {
				return rtVal{}, fmt.Errorf("«%s» нельзя преобразовать в число", str)
			}
			f = v
		}
		return rtVal{F: float64(int64(f))}, nil
	case "float":
		if fromFormat == "string" {
			v, err := strconv.ParseFloat(strings.Replace(strings.TrimSpace(str), ",", ".", 1), 64)
			if err != nil {
				return rtVal{}, fmt.Errorf("«%s» нельзя преобразовать в число", str)
			}
			f = v
		}
		return rtVal{F: f}, nil
	case "string":
		if fromFormat == "string" {
			return rtVal{S: str}, nil
		}
		if fromFormat == "bool" {
			if f != 0 {
				return rtVal{S: "true"}, nil
			}
			return rtVal{S: "false"}, nil
		}
		return rtVal{S: strconv.FormatFloat(f, 'f', -1, 64)}, nil
	}
	return rtVal{}, fmt.Errorf("неизвестный формат %q", format)
}

func validFormat(f string) bool { return f == "bool" || f == "int" || f == "float" || f == "string" }

// ---- scenario -> registry --------------------------------------------------------------

// SyncScenarioVars makes the variables of every "RS-485: Parse" row exist (same name, format and description as the row).
func (s *Store) SyncScenarioVars(raw []byte) {
	var g scenarioGraph
	if json.Unmarshal(raw, &g) != nil {
		return
	}
	want := map[string]VarDef{}
	for _, n := range g.Nodes {
		if n.Data.Type != "rs485_parse" {
			continue
		}
		rows, _ := n.Data.Config["registerTable"].([]interface{})
		for _, r := range rows {
			m, _ := r.(map[string]interface{})
			name := strings.TrimSpace(cfgStr(m, "name", ""))
			if name == "" {
				continue
			}
			want[vkey(name)] = VarDef{Name: name, Format: formatOfType(cfgStr(m, "dataType", "uint8")),
				Description: cfgStr(m, "description", ""), Source: "rs485"}
		}
	}
	s.mu.Lock()
	for k, d := range s.data.Vars {
		if d.Source == "rs485" {
			if _, keep := want[k]; !keep {
				delete(s.data.Vars, k)
				delete(s.rt, k)
			}
		}
	}
	for k, d := range want {
		if old, ok := s.data.Vars[k]; ok {
			if d.Description == "" {
				d.Description = old.Description
			}
			if old.Source == "custom" {
				continue // the user's own variable with the same name wins
			}
		}
		s.data.Vars[k] = d
	}
	_ = s.saveLocked()
	s.mu.Unlock()
}

// ---- HTTP ---------------------------------------------------------------------------------

func (a *API) listVars(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, a.st.Variables()) }

// PUT /api/variables {name, format, description}  — create a custom variable, or change the description of any variable
func (a *API) putVar(w http.ResponseWriter, r *http.Request) {
	var in VarDef
	body, _ := readBody(r)
	if json.Unmarshal(body, &in) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad body"})
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	k := vkey(in.Name)
	if k == "" || strings.ContainsAny(k, "{} \t") {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "Недопустимое имя переменной"})
		return
	}
	a.st.mu.Lock()
	defer a.st.mu.Unlock()
	exists := false
	for _, v := range a.st.variablesNamesLocked() {
		if v == k {
			exists = true
		}
	}
	old, reg := a.st.data.Vars[k]
	switch {
	case exists && !reg: // a hardware variable: only the description is editable
		a.st.data.Vars[k] = VarDef{Name: in.Name, Format: "bool", Description: in.Description, Source: "builtin"}
	case reg:
		old.Description = in.Description
		a.st.data.Vars[k] = old
	default:
		if !validFormat(in.Format) {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "Недопустимый формат данных"})
			return
		}
		a.st.data.Vars[k] = VarDef{Name: in.Name, Format: in.Format, Description: in.Description, Source: "custom"}
	}
	if err := a.st.saveLocked(); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Store) variablesNamesLocked() []string {
	var out []string
	for i := 1; i <= nButtons; i++ {
		out = append(out, fmt.Sprintf("BTN-%d", i))
	}
	for i := 1; i <= nLeds; i++ {
		out = append(out, fmt.Sprintf("LED-%d", i))
	}
	for i, nm := range s.moduleNamesLocked() {
		if nm != "" && s.slots[i].typ == "relay" {
			out = append(out, vkey(nm))
		}
	}
	return out
}

// DELETE /api/variables?name=X
func (a *API) deleteVar(w http.ResponseWriter, r *http.Request) {
	k := vkey(r.URL.Query().Get("name"))
	a.st.mu.Lock()
	d, ok := a.st.data.Vars[k]
	if ok && d.Source != "builtin" {
		delete(a.st.data.Vars, k)
		delete(a.st.rt, k)
		_ = a.st.saveLocked()
	}
	a.st.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /api/variables/set {name, value?, from?}  — assign a literal value or another variable.
// "from" (a variable name) wins over "value". Hardware variables (LED, relay) are switched for real unless a scenario runs.
func (a *API) setVar(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name  string `json:"name"`
		Value any    `json:"value"`
		From  string `json:"from"`
	}
	body, _ := readBody(r)
	if json.Unmarshal(body, &in) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad body"})
		return
	}
	fail := func(m string) { writeJSON(w, 200, map[string]any{"ok": false, "error": m}) }

	// source value
	var f float64
	var str, fromFormat string
	if strings.TrimSpace(in.From) != "" {
		var src *VarView
		for _, v := range a.st.Variables() {
			if vkey(v.Name) == vkey(in.From) {
				v := v
				src = &v
			}
		}
		if src == nil {
			fail("Переменная-источник не найдена: " + in.From)
			return
		}
		fromFormat = src.Format
		switch x := src.Value.(type) {
		case bool:
			if x {
				f = 1
			}
		case int64:
			f = float64(x)
		case float64:
			f = x
		case string:
			str = x
		}
	} else {
		switch x := in.Value.(type) {
		case bool:
			fromFormat = "bool"
			if x {
				f = 1
			}
		case float64:
			fromFormat, f = "float", x
			if x == float64(int64(x)) {
				fromFormat = "int"
			}
		case string:
			fromFormat, str = "string", x
		default:
			fail("Не задано значение")
			return
		}
	}

	k := vkey(in.Name)
	var target *VarView
	for _, v := range a.st.Variables() {
		if vkey(v.Name) == k {
			v := v
			target = &v
		}
	}
	if target == nil {
		fail("Переменная не найдена")
		return
	}
	if !target.Writable {
		fail("Эта переменная только для чтения")
		return
	}
	val, err := convertTo(target.Format, f, str, fromFormat)
	if err != nil {
		fail(err.Error())
		return
	}
	switch target.Source {
	case "led":
		if a.en.Locked() {
			fail(lockedMsg)
			return
		}
		n, _ := strconv.Atoi(k[4:])
		if err := a.dc.SetLed(n, val.F != 0); err != nil {
			fail(err.Error())
			return
		}
	case "relay":
		if a.en.Locked() {
			fail(lockedMsg)
			return
		}
		slot := a.st.SlotByName(k)
		if err := a.dc.SetRelay(slot, 1, val.F != 0); err != nil {
			fail(err.Error())
			return
		}
		a.st.SetManual(fmt.Sprintf("relay%d", slot), val.F != 0)
	default:
		a.st.mu.Lock()
		a.st.rt[k] = val
		a.st.mu.Unlock()
		a.st.hub.Publish("variable", map[string]any{"name": target.Name})
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

const lockedMsg = "Сценарий запущен: ручное управление отключено. Остановите сценарий."

func (s *Store) SetManual(key string, on bool) {
	s.mu.Lock()
	s.manual[key] = on
	s.mu.Unlock()
}

func (s *Store) ManualSnapshot() map[string]bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]bool{}
	for k, v := range s.manual {
		out[k] = v
	}
	return out
}
