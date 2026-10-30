package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Scenario engine: runs the graph drawn in the web UI on the device.
//
// Execution model
//   - A node without incoming connections is a ROOT.
//   - Trigger roots ("button" and "RS-485 receive") run their chain every time
//     the event happens (button pressed/released, a frame arrived).
//   - Any other root (LED, relay, if/else, while ...) runs once when the
//     scenario starts.
//   - A chain runs node by node following the connections; if/else follows the
//     "true" or "false" connection, while repeats everything connected to it.
//
// Variables usable in if/else and while:
//   BTN-1..BTN-3      button pressed (1) / released (0)
//   LED-1..LED-3      LED on (1) / off (0)
//   Relay-<n>         relay module (single channel) on / off, e.g. Relay-0
//   RS485-<n>.<i>     value set by an "RS-485 parse" node (i = row number or row name), e.g. RS485-0.TEMP
// Modules are named per type in slot order (see Store.moduleNamesLocked): RS485-0, RS485-1, Relay-0 ...

type graphNode struct {
	ID   string `json:"id"`
	Data struct {
		Type   string                 `json:"type"`
		Config map[string]interface{} `json:"config"`
	} `json:"data"`
}

type graphEdge struct {
	Source       string  `json:"source"`
	Target       string  `json:"target"`
	SourceHandle *string `json:"sourceHandle"`
}

type scenarioGraph struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Nodes []graphNode `json:"nodes"`
	Edges []graphEdge `json:"edges"`
}

type RunStatus struct {
	Running      bool    `json:"running"`
	ActiveNodeID *string `json:"activeNodeId"`
	LastError    *string `json:"lastError"`
}

type frame struct {
	slot int
	data []byte
}

type subscription struct {
	pred func(typ string, payload any) bool
	ch   chan any
}

type Engine struct {
	st  *Store
	dc  *DaemonClient
	hub *Hub

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	status  RunStatus
	vars    map[string]float64 // set by parse nodes
	subs    map[*subscription]struct{}
}

func NewEngine(st *Store, dc *DaemonClient, hub *Hub) *Engine {
	e := &Engine{st: st, dc: dc, hub: hub, vars: map[string]float64{}, subs: map[*subscription]struct{}{}}
	hub.OnEvent(e.onEvent)
	return e
}

func (e *Engine) onEvent(typ string, payload any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for s := range e.subs {
		if s.pred(typ, payload) {
			select {
			case s.ch <- payload:
			default: // consumer is busy and its queue is full: drop
			}
		}
	}
}

func (e *Engine) subscribe(pred func(string, any) bool) *subscription {
	s := &subscription{pred: pred, ch: make(chan any, 32)}
	e.mu.Lock()
	e.subs[s] = struct{}{}
	e.mu.Unlock()
	return s
}

func (e *Engine) unsubscribe(s *subscription) {
	e.mu.Lock()
	delete(e.subs, s)
	e.mu.Unlock()
}

func (e *Engine) Status() RunStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

func (e *Engine) publish(running bool, active string, errMsg string) {
	e.mu.Lock()
	e.status.Running = running
	if active == "" {
		e.status.ActiveNodeID = nil
	} else {
		e.status.ActiveNodeID = &active
	}
	if errMsg != "" {
		e.status.LastError = &errMsg
	}
	st := e.status
	e.mu.Unlock()
	e.hub.Publish("scenario_status", st)
}

func (e *Engine) fail(msg string) {
	log.Printf("scenario: %s", msg)
	e.publish(true, "", msg)
}

// ---- start / stop ------------------------------------------------------------

func (e *Engine) Start(id string) error {
	raw, ok := e.st.Scenario(id)
	if !ok {
		return errors.New("сценарий не найден (сохраните его и повторите)")
	}
	var g scenarioGraph
	if err := json.Unmarshal(raw, &g); err != nil {
		return errors.New("сценарий повреждён")
	}
	if len(g.Nodes) == 0 {
		return errors.New("сценарий пуст")
	}
	e.Stop()

	byID := map[string]*graphNode{}
	for i := range g.Nodes {
		byID[g.Nodes[i].ID] = &g.Nodes[i]
	}
	out := map[string][]graphEdge{}
	hasIn := map[string]bool{}
	for _, ed := range g.Edges {
		if byID[ed.Source] == nil || byID[ed.Target] == nil {
			continue
		}
		out[ed.Source] = append(out[ed.Source], ed)
		hasIn[ed.Target] = true
	}

	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.running = true
	e.cancel = cancel
	e.vars = map[string]float64{}
	e.status = RunStatus{Running: true}
	e.mu.Unlock()
	e.st.SetRunning(id)

	run := &runner{e: e, ctx: ctx, byID: byID, out: out}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if hasIn[n.ID] {
			continue
		}
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			run.runRoot(n)
		}()
	}
	e.publish(true, "", "")
	log.Printf("scenario %q started (%d nodes)", g.Name, len(g.Nodes))
	return nil
}

func (e *Engine) Stop() {
	e.mu.Lock()
	cancel := e.cancel
	was := e.running
	e.running = false
	e.cancel = nil
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	e.wg.Wait()
	if was {
		e.publish(false, "", "")
		e.mu.Lock()
		e.status.LastError = nil
		e.mu.Unlock()
		log.Printf("scenario stopped")
	}
}

// StopAndForget is the user pressing "Stop": do not resume after a reboot.
func (e *Engine) StopAndForget() {
	e.Stop()
	e.st.SetRunning("")
}

// ---- execution ---------------------------------------------------------------------

type runner struct {
	e    *Engine
	ctx  context.Context
	byID map[string]*graphNode
	out  map[string][]graphEdge
}

type runCtx struct {
	frame *frame
	steps int
}

func (r *runner) alive() bool { return r.ctx.Err() == nil }

// moduleSlot resolves the "module" setting of a node (e.g. "RS485-0") to a slot number.
// Scenarios saved by older versions carry a plain "slot" number instead.
func (e *Engine) moduleSlot(c map[string]interface{}) (slot int, name string) {
	if n := strings.TrimSpace(cfgStr(c, "module", "")); n != "" {
		return e.st.SlotByName(n), n
	}
	sl := cfgInt(c, "slot", 1)
	return sl, e.st.ModuleName(sl)
}

func (r *runner) runRoot(n *graphNode) {
	switch n.Data.Type {
	case "button_event":
		num := cfgInt(n.Data.Config, "button", 1)
		edge := cfgStr(n.Data.Config, "event", "pressed")
		sub := r.e.subscribe(func(typ string, p any) bool {
			b, ok := p.(ButtonState)
			return typ == "io_button" && ok && b.N == num && b.Pressed == (edge != "released")
		})
		defer r.e.unsubscribe(sub)
		for r.alive() {
			select {
			case <-r.ctx.Done():
				return
			case <-sub.ch:
				r.chain(n, &runCtx{})
			}
		}
	case "rs485_receive":
		sub := r.rxSub(n.Data.Config)
		defer r.e.unsubscribe(sub)
		for r.alive() {
			select {
			case <-r.ctx.Done():
				return
			case p := <-sub.ch:
				ent := p.(RS485Entry)
				raw, _ := hex.DecodeString(ent.Hex)
				r.chain(n, &runCtx{frame: &frame{slot: ent.Slot, data: raw}})
			}
		}
	default:
		r.chain(n, &runCtx{})
	}
}

func (r *runner) rxSub(c map[string]interface{}) *subscription {
	return r.e.subscribe(func(typ string, p any) bool {
		en, ok := p.(RS485Entry)
		if typ != "rs485_data" || !ok || en.Dir != "rx" {
			return false
		}
		slot, _ := r.e.moduleSlot(c) // resolved on every frame: the module may be plugged in later
		return slot == en.Slot
	})
}

// chain executes the nodes connected after a trigger root (the root itself is a trigger: its
// own action is "wait for the event", already done) or a plain root once.
func (r *runner) chain(n *graphNode, rc *runCtx) {
	defer r.e.publish(true, "", "")
	if isTrigger(n.Data.Type) {
		r.followAll(n, rc, "")
		return
	}
	r.exec(n, rc, 0)
}

func isTrigger(t string) bool { return t == "button_event" || t == "rs485_receive" }

func (r *runner) followAll(n *graphNode, rc *runCtx, handle string) {
	for _, ed := range r.out[n.ID] {
		if !r.alive() {
			return
		}
		if handle != "" && (ed.SourceHandle == nil || *ed.SourceHandle != handle) {
			continue
		}
		if next := r.byID[ed.Target]; next != nil {
			r.exec(next, rc, 1)
		}
	}
}

const maxDepth = 200
const maxSteps = 100000

func (r *runner) exec(n *graphNode, rc *runCtx, depth int) {
	if !r.alive() {
		return
	}
	rc.steps++
	if depth > maxDepth || rc.steps > maxSteps {
		r.e.fail("превышена глубина сценария (цикл без выхода?) в узле " + n.ID)
		return
	}
	r.e.publish(true, n.ID, "")
	c := n.Data.Config

	switch n.Data.Type {
	case "led_set":
		num := cfgInt(c, "led", 1)
		state := cfgStr(c, "state", "ON")
		on := state == "ON"
		if state == "TOGGLE" {
			cur, _ := r.e.st.LedOn(num)
			on = !cur
		}
		if err := r.e.dc.SetLed(num, on); err != nil {
			r.e.fail(fmt.Sprintf("светодиод %d: %v", num, err))
		}
		r.followAll(n, rc, "")

	case "relay_set":
		slot, name := r.e.moduleSlot(c)
		state := cfgStr(c, "state", "ON")
		on := state == "ON"
		if state == "TOGGLE" {
			cur, _ := r.e.st.RelayOn(slot, 1)
			on = !cur
		}
		if typ, ok := r.e.st.SlotType(slot); slot == 0 || !ok || typ != "relay" {
			r.e.fail(fmt.Sprintf("реле %s не подключено", displayName(name, "Relay")))
		} else if err := r.e.dc.SetRelay(slot, 1, on); err != nil {
			r.e.fail(fmt.Sprintf("%s: %v", name, err))
		}
		r.followAll(n, rc, "")

	case "button_event": // in the middle of a chain: wait for the next press
		num := cfgInt(c, "button", 1)
		edge := cfgStr(c, "event", "pressed")
		sub := r.e.subscribe(func(typ string, p any) bool {
			b, ok := p.(ButtonState)
			return typ == "io_button" && ok && b.N == num && b.Pressed == (edge != "released")
		})
		select {
		case <-r.ctx.Done():
		case <-sub.ch:
			r.e.unsubscribe(sub)
			r.followAll(n, rc, "")
			return
		}
		r.e.unsubscribe(sub)

	case "rs485_receive": // in the middle of a chain: wait for the next frame (10 s)
		_, name := r.e.moduleSlot(c)
		sub := r.rxSub(c)
		select {
		case <-r.ctx.Done():
		case p := <-sub.ch:
			ent := p.(RS485Entry)
			raw, _ := hex.DecodeString(ent.Hex)
			rc.frame = &frame{slot: ent.Slot, data: raw}
			r.e.unsubscribe(sub)
			r.followAll(n, rc, "")
			return
		case <-time.After(10 * time.Second):
			r.e.fail(fmt.Sprintf("%s: данные не получены за 10 с", displayName(name, "RS485")))
		}
		r.e.unsubscribe(sub)

	case "rs485_parse":
		if rc.frame == nil {
			r.e.fail("RS-485 парсинг: нет принятого кадра (поставьте после «RS-485: Приём»)")
		} else if err := r.e.parse(rc.frame, c); err != nil {
			r.e.fail("RS-485 парсинг: " + err.Error())
		}
		r.followAll(n, rc, "")

	case "rs485_send":
		slot, name := r.e.moduleSlot(c)
		data, err := r.e.payload(c)
		if err != nil {
			r.e.fail("RS-485 отправка: " + err.Error())
		} else if typ, ok := r.e.st.SlotType(slot); slot == 0 || !ok || typ != "rs485" {
			r.e.fail(fmt.Sprintf("%s не подключён", displayName(name, "RS485")))
		} else if err := r.e.dc.RS485Send(slot, data); err != nil {
			r.e.fail(fmt.Sprintf("%s: %v", name, err))
		}
		r.followAll(n, rc, "")

	case "if_else":
		ok, err := r.e.cond(c)
		if err != nil {
			r.e.fail("условие: " + err.Error())
			return
		}
		if ok {
			r.followAll(n, rc, "true")
		} else {
			r.followAll(n, rc, "false")
		}

	case "while":
		maxIter := cfgInt(c, "maxIterations", 10000)
		interval := time.Duration(cfgInt(c, "intervalMs", 100)) * time.Millisecond
		if interval < 10*time.Millisecond {
			interval = 10 * time.Millisecond
		}
		for i := 0; i < maxIter && r.alive(); i++ {
			ok, err := r.e.cond(c)
			if err != nil {
				r.e.fail("цикл: " + err.Error())
				return
			}
			if !ok {
				break
			}
			r.followAll(n, rc, "")
			select {
			case <-r.ctx.Done():
				return
			case <-time.After(interval):
			}
		}

	case "delay":
		d := time.Duration(cfgInt(c, "ms", 1000)) * time.Millisecond
		select {
		case <-r.ctx.Done():
			return
		case <-time.After(d):
		}
		r.followAll(n, rc, "")

	default:
		r.e.fail("неизвестный тип узла: " + n.Data.Type)
	}
}

func displayName(name, def string) string {
	if name == "" {
		return def
	}
	return name
}

// ---- variables / conditions ---------------------------------------------------------

func (e *Engine) variable(name string) (float64, error) {
	name = strings.TrimSpace(name)
	up := strings.ToUpper(name)
	b2f := func(v bool) float64 {
		if v {
			return 1
		}
		return 0
	}
	switch {
	case strings.HasPrefix(up, "BTN-"):
		if n, err := strconv.Atoi(up[4:]); err == nil {
			if v, ok := e.st.ButtonPressed(n); ok {
				return b2f(v), nil
			}
		}
	case strings.HasPrefix(up, "LED-"):
		if n, err := strconv.Atoi(up[4:]); err == nil {
			if v, ok := e.st.LedOn(n); ok {
				return b2f(v), nil
			}
		}
	case strings.HasPrefix(up, "RELAY-"):
		if slot := e.st.SlotByName(up); slot > 0 {
			if v, ok := e.st.RelayOn(slot, 1); ok {
				return b2f(v), nil
			}
		}
	}
	e.mu.Lock()
	v, ok := e.vars[up]
	e.mu.Unlock()
	if ok {
		return v, nil
	}
	return 0, fmt.Errorf("переменная %q не определена", name)
}

func (e *Engine) cond(c map[string]interface{}) (bool, error) {
	v, err := e.variable(cfgStr(c, "variable", ""))
	if err != nil {
		return false, err
	}
	rhsText := strings.TrimSpace(cfgStr(c, "value", "0"))
	rhs, perr := strconv.ParseFloat(strings.Replace(rhsText, ",", ".", 1), 64)
	if perr != nil { // the right side may be another variable
		if rhs, err = e.variable(rhsText); err != nil {
			return false, fmt.Errorf("значение %q не число и не переменная", rhsText)
		}
	}
	switch cfgStr(c, "operator", "==") {
	case "==":
		return v == rhs, nil
	case "!=":
		return v != rhs, nil
	case ">":
		return v > rhs, nil
	case "<":
		return v < rhs, nil
	case ">=":
		return v >= rhs, nil
	case "<=":
		return v <= rhs, nil
	}
	return false, errors.New("неизвестный оператор")
}

// parse decodes a received frame with the register table (big-endian, byte offsets).
func (e *Engine) parse(f *frame, c map[string]interface{}) error {
	rows, _ := c["registerTable"].([]interface{})
	if len(rows) == 0 {
		return errors.New("таблица регистров пуста")
	}
	mod := strings.ToUpper(e.st.ModuleName(f.slot))
	if mod == "" {
		mod = fmt.Sprintf("RS485-%d", f.slot)
	}
	for i, r := range rows {
		m, _ := r.(map[string]interface{})
		off := cfgInt(m, "byteIndex", 0)
		typ := cfgStr(m, "dataType", "uint8")
		name := strings.ToUpper(strings.TrimSpace(cfgStr(m, "name", "")))
		size := map[string]int{"uint8": 1, "int8": 1, "bool": 1, "uint16": 2, "int16": 2, "uint32": 4, "int32": 4, "float32": 4}[typ]
		if size == 0 || off < 0 || off+size > len(f.data) {
			return fmt.Errorf("строка %d: байт %d (%s) вне кадра длиной %d", i+1, off, typ, len(f.data))
		}
		b := f.data[off : off+size]
		var v float64
		switch typ {
		case "uint8":
			v = float64(b[0])
		case "int8":
			v = float64(int8(b[0]))
		case "bool":
			if b[0] != 0 {
				v = 1
			}
		case "uint16":
			v = float64(binary.BigEndian.Uint16(b))
		case "int16":
			v = float64(int16(binary.BigEndian.Uint16(b)))
		case "uint32":
			v = float64(binary.BigEndian.Uint32(b))
		case "int32":
			v = float64(int32(binary.BigEndian.Uint32(b)))
		case "float32":
			v = float64(math.Float32frombits(binary.BigEndian.Uint32(b)))
		}
		e.mu.Lock()
		e.vars[fmt.Sprintf("%s.%d", mod, i+1)] = v
		if name != "" {
			e.vars[fmt.Sprintf("%s.%s", mod, name)] = v
		}
		e.mu.Unlock()
	}
	return nil
}

// payload builds the bytes for an RS-485 send node. {NAME} is replaced by the variable value.
func (e *Engine) payload(c map[string]interface{}) ([]byte, error) {
	text := cfgStr(c, "data", "")
	for {
		i := strings.Index(text, "{")
		j := strings.Index(text, "}")
		if i < 0 || j < i {
			break
		}
		v, err := e.variable(text[i+1 : j])
		if err != nil {
			return nil, err
		}
		text = text[:i] + strconv.FormatFloat(v, 'f', -1, 64) + text[j+1:]
	}
	switch cfgStr(c, "mode", "Текст") {
	case "HEX":
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == ':' || r == '-' {
				return -1
			}
			return r
		}, text)
		b, err := hex.DecodeString(clean)
		if err != nil || len(b) == 0 {
			return nil, errors.New("неверный HEX")
		}
		return b, nil
	case "JSON (переменные)":
		e.mu.Lock()
		m := map[string]float64{}
		for k, v := range e.vars {
			m[k] = v
		}
		e.mu.Unlock()
		b, _ := json.Marshal(m)
		return append(b, '\n'), nil
	default:
		s := strings.NewReplacer(`\r`, "\r", `\n`, "\n", `\t`, "\t").Replace(text)
		if s == "" {
			return nil, errors.New("пустые данные")
		}
		return []byte(s), nil
	}
}

// ---- config helpers (JSON numbers arrive as float64, the UI may also store strings) --------

func cfgStr(c map[string]interface{}, k, def string) string {
	switch v := c[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return def
}

func cfgInt(c map[string]interface{}, k string, def int) int {
	switch v := c[k].(type) {
	case float64:
		return int(v)
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}
