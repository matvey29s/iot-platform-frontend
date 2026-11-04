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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Scenario engine: runs the graph drawn in the web UI on the device.
//
// Execution model
//   - Every block has an input "in" (left) and an output "out" (right). A block without an incoming connection
//     is a START of the scenario; a block whose "out" leads nowhere ends its flow (nothing left to do).
//   - if/else has the output "out" plus one output "c1".."c10" per condition: the first condition that holds runs its
//     branch and then the flow continues from "out"; if none holds it continues from "out" at once.
//   - while has "true" (loop body, taken while the condition holds) and "out" (taken when it does not).
//   - Button / RS-485 receive / delay are waiting blocks: the flow stops there until the event happens.
//   - A "parallel gateway" block (no input; outputs t1..tN) starts N tasks that run at the same time. When a gateway
//     exists it is the only start of the scenario. Tasks of a gateway with a lower priority number are served first
//     (every non-waiting step takes a priority-ordered turn, like a priority scheduler: a waiting task never blocks).
//
// Variables usable in conditions and payloads:
//   BTN-1..BTN-3, LED-1..LED-3, Relay-<n>, custom variables and variables made by "RS-485: Parse" rows.

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
	Running       bool     `json:"running"`
	ActiveNodeID  *string  `json:"activeNodeId"`
	ActiveNodeIDs []string `json:"activeNodeIds"`
	LastError     *string  `json:"lastError"`
}

type frame struct {
	slot int
	data []byte
}

type subscription struct {
	pred func(typ string, payload any) bool
	ch   chan any
}

type run struct {
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

type Engine struct {
	st  *Store
	dc  *DaemonClient
	hub *Hub

	mu     sync.Mutex
	cur    *run
	status RunStatus
	active map[string]int
	subs   map[*subscription]struct{}
	gate   prioGate
}

func NewEngine(st *Store, dc *DaemonClient, hub *Hub) *Engine {
	e := &Engine{st: st, dc: dc, hub: hub, active: map[string]int{}, subs: map[*subscription]struct{}{}}
	hub.OnEvent(e.onEvent)
	return e
}

// Locked: while a scenario runs, manual control from the Device tab is disabled.
func (e *Engine) Locked() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.cur != nil
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
	return e.statusLocked()
}

func (e *Engine) statusLocked() RunStatus {
	st := e.status
	st.Running = e.cur != nil
	st.ActiveNodeIDs = []string{}
	for id := range e.active {
		st.ActiveNodeIDs = append(st.ActiveNodeIDs, id)
	}
	sort.Strings(st.ActiveNodeIDs)
	st.ActiveNodeID = nil
	if len(st.ActiveNodeIDs) > 0 {
		id := st.ActiveNodeIDs[0]
		st.ActiveNodeID = &id
	}
	return st
}

func (e *Engine) publishStatus(errMsg string) {
	e.mu.Lock()
	if errMsg != "" {
		e.status.LastError = &errMsg
	}
	st := e.statusLocked()
	e.mu.Unlock()
	e.hub.Publish("scenario_status", st)
}

func (e *Engine) setActive(id string, on bool) {
	e.mu.Lock()
	if on {
		e.active[id]++
	} else if e.active[id] > 0 {
		e.active[id]--
		if e.active[id] == 0 {
			delete(e.active, id)
		}
	}
	e.mu.Unlock()
	e.publishStatus("")
}

func (e *Engine) fail(msg string) {
	log.Printf("scenario: %s", msg)
	e.publishStatus(msg)
}

// ---- priority gate -------------------------------------------------------------------------

type gwait struct {
	prio int
	seq  uint64
	ch   chan struct{}
}

// prioGate lets one task at a time execute a non-waiting step; the waiting task with the lowest priority number
// (0 = highest) is granted first.
type prioGate struct {
	mu   sync.Mutex
	held bool
	seq  uint64
	q    []*gwait
}

func (g *prioGate) acquire(ctx context.Context, prio int) bool {
	g.mu.Lock()
	if !g.held && len(g.q) == 0 {
		g.held = true
		g.mu.Unlock()
		return true
	}
	g.seq++
	w := &gwait{prio, g.seq, make(chan struct{})}
	g.q = append(g.q, w)
	g.mu.Unlock()
	select {
	case <-w.ch:
		return true
	case <-ctx.Done():
		g.mu.Lock()
		for i, x := range g.q {
			if x == w {
				g.q = append(g.q[:i], g.q[i+1:]...)
				g.mu.Unlock()
				return false
			}
		}
		g.mu.Unlock() // it was granted just now: give the turn back
		g.release()
		return false
	}
}

func (g *prioGate) release() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.q) == 0 {
		g.held = false
		return
	}
	best := 0
	for i, w := range g.q {
		if w.prio < g.q[best].prio || (w.prio == g.q[best].prio && w.seq < g.q[best].seq) {
			best = i
		}
	}
	w := g.q[best]
	g.q = append(g.q[:best], g.q[best+1:]...)
	close(w.ch) // the turn passes on, held stays true
}

// ---- start / stop ------------------------------------------------------------------------------

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
	var roots []*graphNode
	for i := range g.Nodes {
		if g.Nodes[i].Data.Type == "parallel_gateway" {
			roots = append(roots, &g.Nodes[i])
		}
	}
	if len(roots) == 0 { // no gateway: every block without an input starts
		for i := range g.Nodes {
			if !hasIn[g.Nodes[i].ID] {
				roots = append(roots, &g.Nodes[i])
			}
		}
	}
	if len(roots) == 0 {
		return errors.New("нет стартового блока: у всех блоков есть входящая связь")
	}

	// the scenario owns the outputs now: whatever was switched by hand is switched off until Stop
	e.allOff()

	ctx, cancel := context.WithCancel(context.Background())
	rn := &run{cancel: cancel}
	e.mu.Lock()
	e.cur = rn
	e.active = map[string]int{}
	e.status = RunStatus{}
	e.mu.Unlock()
	e.st.SetRunning(id)

	r := &runner{e: e, ctx: ctx, byID: byID, out: out}
	for _, n := range roots {
		n := n
		rn.wg.Add(1)
		go func() {
			defer rn.wg.Done()
			r.runChain(n, &runCtx{}, 0, 0)
		}()
	}
	go func() { // every flow reached its end: the scenario is complete
		rn.wg.Wait()
		e.mu.Lock()
		same := e.cur == rn
		if same {
			e.cur = nil
			e.active = map[string]int{}
		}
		e.mu.Unlock()
		if same {
			cancel()
			e.st.SetRunning("")
			e.restoreManual()
			e.publishStatus("")
			log.Printf("scenario completed")
		}
	}()
	e.publishStatus("")
	log.Printf("scenario %q started (%d nodes)", g.Name, len(g.Nodes))
	return nil
}

// Stop ends the scenario (if one runs) without touching the saved "resume after reboot" mark.
func (e *Engine) Stop() {
	e.mu.Lock()
	rn := e.cur
	e.mu.Unlock()
	if rn == nil {
		return
	}
	rn.cancel()
	rn.wg.Wait()
	e.mu.Lock()
	if e.cur == rn {
		e.cur = nil
		e.active = map[string]int{}
	}
	e.mu.Unlock()
	e.publishStatus("")
	log.Printf("scenario stopped")
}

// StopAndForget is the user pressing "Stop": do not resume after a reboot, give the outputs back to the Device tab.
func (e *Engine) StopAndForget() {
	e.Stop()
	e.st.SetRunning("")
	e.restoreManual()
}

func (e *Engine) allOff() {
	for n := 1; n <= nLeds; n++ {
		_ = e.dc.SetLed(n, false)
	}
	for slot := 1; slot <= nSlots; slot++ {
		if t, ok := e.st.SlotType(slot); ok && t == "relay" {
			_ = e.dc.SetRelay(slot, 1, false)
		}
	}
}

// restoreManual re-applies what the user had set by hand on the Device tab before the scenario took over.
func (e *Engine) restoreManual() {
	for slot := 1; slot <= nSlots; slot++ {
		t, ok := e.st.SlotType(slot)
		if !ok || t != "relay" {
			continue
		}
		on := e.st.ManualSnapshot()[fmt.Sprintf("relay%d", slot)]
		_ = e.dc.SetRelay(slot, 1, on)
	}
	for n := 1; n <= nLeds; n++ {
		_ = e.dc.SetLed(n, false)
	}
}

// ---- execution ---------------------------------------------------------------------------------

type runner struct {
	e    *Engine
	ctx  context.Context
	byID map[string]*graphNode
	out  map[string][]graphEdge
}

type runCtx struct {
	frame *frame
	prio  int
}

func (r *runner) alive() bool { return r.ctx.Err() == nil }

// moduleSlot resolves the "module" setting of a node (e.g. "RS485-0") to a slot number.
func (e *Engine) moduleSlot(c map[string]interface{}) (slot int, name string) {
	if n := strings.TrimSpace(cfgStr(c, "module", "")); n != "" {
		return e.st.SlotByName(n), n
	}
	sl := cfgInt(c, "slot", 1)
	return sl, e.st.ModuleName(sl)
}

// next: the block behind the connection that leaves `handle` of n (nil = the flow ends here).
func (r *runner) next(n *graphNode, handle string) *graphNode {
	for _, ed := range r.out[n.ID] {
		h := "out"
		if ed.SourceHandle != nil && *ed.SourceHandle != "" {
			h = *ed.SourceHandle
		}
		if h == handle {
			return r.byID[ed.Target]
		}
	}
	return nil
}

const maxDepth = 400

// runChain executes blocks one after another starting at n until a block has nothing connected behind its output.
func (r *runner) runChain(n *graphNode, rc *runCtx, prio, depth int) {
	rc.prio = prio
	for n != nil && r.alive() {
		if depth > maxDepth {
			r.e.fail("слишком глубокая вложенность циклов/условий в блоке " + n.ID)
			return
		}
		r.e.setActive(n.ID, true)
		nx := r.exec(n, rc, depth)
		r.e.setActive(n.ID, false)
		n = nx
		r.sleep(2 * time.Millisecond) // a loop made only of instant blocks must not hog the CPU
	}
}

func (r *runner) sleep(d time.Duration) bool {
	select {
	case <-r.ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// step runs a non-waiting action under the priority gate.
func (r *runner) step(rc *runCtx, fn func()) {
	if !r.e.gate.acquire(r.ctx, rc.prio) {
		return
	}
	defer r.e.gate.release()
	fn()
}

func (r *runner) exec(n *graphNode, rc *runCtx, depth int) *graphNode {
	c := n.Data.Config
	switch n.Data.Type {
	case "led_set":
		num := cfgInt(c, "led", 1)
		state := cfgStr(c, "state", "ON")
		r.step(rc, func() {
			on := state == "ON"
			if state == "TOGGLE" {
				cur, _ := r.e.st.LedOn(num)
				on = !cur
			}
			if err := r.e.dc.SetLed(num, on); err != nil {
				r.e.fail(fmt.Sprintf("светодиод %d: %v", num, err))
			}
		})

	case "relay_set":
		slot, name := r.e.moduleSlot(c)
		state := cfgStr(c, "state", "ON")
		r.step(rc, func() {
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
		})

	case "button_event":
		r.waitButton(cfgInt(c, "button", 1), cfgStr(c, "event", "rising"))

	case "rs485_receive":
		sub := r.rxSub(c)
		select {
		case <-r.ctx.Done():
		case p := <-sub.ch:
			ent := p.(RS485Entry)
			raw, _ := hex.DecodeString(ent.Hex)
			rc.frame = &frame{slot: ent.Slot, data: raw}
		}
		r.e.unsubscribe(sub)

	case "rs485_parse":
		r.step(rc, func() {
			if rc.frame == nil {
				r.e.fail("RS-485 парсинг: нет принятого кадра (поставьте после «RS-485: Приём»)")
			} else if err := r.e.parse(rc.frame, c); err != nil {
				r.e.fail("RS-485 парсинг: " + err.Error())
			}
		})

	case "rs485_send":
		slot, name := r.e.moduleSlot(c)
		r.step(rc, func() {
			data, err := r.e.payload(c)
			if err != nil {
				r.e.fail("RS-485 отправка: " + err.Error())
			} else if typ, ok := r.e.st.SlotType(slot); slot == 0 || !ok || typ != "rs485" {
				r.e.fail(fmt.Sprintf("%s не подключён", displayName(name, "RS485")))
			} else if err := r.e.dc.RS485Send(slot, data); err != nil {
				r.e.fail(fmt.Sprintf("%s: %v", name, err))
			}
		})

	case "if_else":
		conds := conditionsOf(c)
		for i, cd := range conds {
			var ok bool
			var err error
			r.step(rc, func() { ok, err = r.e.cond(cd) })
			if err != nil {
				r.e.fail(fmt.Sprintf("условие %d: %v", i+1, err))
				return nil
			}
			if ok {
				r.runChain(r.next(n, fmt.Sprintf("c%d", i+1)), rc, rc.prio, depth+1)
				break
			}
		}

	case "while":
		interval := time.Duration(cfgInt(c, "intervalMs", 100)) * time.Millisecond
		if interval < 10*time.Millisecond {
			interval = 10 * time.Millisecond
		}
		for r.alive() {
			var ok bool
			var err error
			r.step(rc, func() { ok, err = r.e.cond(c) })
			if err != nil {
				r.e.fail("цикл: " + err.Error())
				return nil
			}
			if !ok {
				break
			}
			r.runChain(r.next(n, "true"), rc, rc.prio, depth+1)
			if !r.sleep(interval) {
				return nil
			}
		}

	case "delay":
		r.sleep(time.Duration(cfgInt(c, "ms", 1000)) * time.Millisecond)

	case "parallel_gateway":
		tasks := cfgInt(c, "tasks", 2)
		if tasks < 1 {
			tasks = 1
		}
		if tasks > 10 {
			tasks = 10
		}
		prio := cfgInt(c, "priority", 0)
		var wg sync.WaitGroup
		for i := 1; i <= tasks; i++ {
			start := r.next(n, fmt.Sprintf("t%d", i))
			if start == nil {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				r.runChain(start, &runCtx{}, prio, depth+1)
			}()
		}
		wg.Wait()
		return nil

	default:
		r.e.fail("неизвестный тип блока: " + n.Data.Type)
		return nil
	}
	if !r.alive() {
		return nil
	}
	return r.next(n, "out")
}

// waitButton blocks until the button satisfies the event:
// level_pressed / level_released: the state itself; rising: released -> pressed; falling: pressed -> released.
func (r *runner) waitButton(num int, event string) {
	switch event { // scenarios made by older versions
	case "pressed":
		event = "rising"
	case "released":
		event = "falling"
	}
	if event == "level_pressed" || event == "level_released" {
		want := event == "level_pressed"
		for r.alive() {
			if v, _ := r.e.st.ButtonPressed(num); v == want {
				return
			}
			if !r.sleep(10 * time.Millisecond) {
				return
			}
		}
		return
	}
	sub := r.e.subscribe(func(typ string, p any) bool {
		b, ok := p.(ButtonState)
		return typ == "io_button" && ok && b.N == num && b.Pressed == (event != "falling")
	})
	defer r.e.unsubscribe(sub)
	select {
	case <-r.ctx.Done():
	case <-sub.ch:
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

func displayName(name, def string) string {
	if name == "" {
		return def
	}
	return name
}

// ---- conditions ------------------------------------------------------------------------------------

func (e *Engine) variable(name string) (float64, error) {
	if v, ok := e.st.VarGet(name); ok {
		return v, nil
	}
	return 0, fmt.Errorf("переменная %q не определена", strings.TrimSpace(name))
}

// conditionsOf: "conditions" is a list of {variable, operator, value}; scenarios made by older versions have one inline.
func conditionsOf(c map[string]interface{}) []map[string]interface{} {
	var out []map[string]interface{}
	if l, ok := c["conditions"].([]interface{}); ok {
		for _, x := range l {
			if m, ok := x.(map[string]interface{}); ok {
				out = append(out, m)
			}
		}
		if len(out) > 10 {
			out = out[:10]
		}
		return out
	}
	return []map[string]interface{}{c}
}

func (e *Engine) cond(c map[string]interface{}) (bool, error) {
	v, err := e.variable(cfgStr(c, "variable", ""))
	if err != nil {
		return false, err
	}
	rhsText := strings.TrimSpace(cfgStr(c, "value", "0"))
	rhs, perr := strconv.ParseFloat(strings.Replace(rhsText, ",", ".", 1), 64)
	if perr != nil { // the right side may be another variable, or true/false
		switch strings.ToLower(rhsText) {
		case "true":
			rhs = 1
		case "false":
			rhs = 0
		default:
			if rhs, err = e.variable(rhsText); err != nil {
				return false, fmt.Errorf("значение %q не число и не переменная", rhsText)
			}
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

// ---- RS-485 parse / payload ------------------------------------------------------------------------

var typeSize = map[string]int{"uint8": 1, "int8": 1, "bool": 1, "uint16": 2, "int16": 2, "uint32": 4, "int32": 4, "float32": 4}

// parse decodes a received frame with the register table (big-endian, byte offsets). Every row with a name becomes
// the variable NAME (and MOD.NAME); every row is also available as MOD.<row number>.
func (e *Engine) parse(f *frame, c map[string]interface{}) error {
	rows, _ := c["registerTable"].([]interface{})
	if len(rows) == 0 {
		return errors.New("таблица регистров пуста")
	}
	mod := strings.ToUpper(e.st.ModuleName(f.slot))
	if mod == "" {
		mod = fmt.Sprintf("RS485-%d", f.slot)
	}
	little := cfgStr(c, "byteOrder", "BE") == "LE"
	for i, r := range rows {
		m, _ := r.(map[string]interface{})
		off := cfgInt(m, "byteIndex", 0)
		typ := cfgStr(m, "dataType", "uint8")
		name := strings.TrimSpace(cfgStr(m, "name", ""))
		size := typeSize[typ]
		if size == 0 || off < 0 || off+size > len(f.data) {
			return fmt.Errorf("строка %d: байт %d (%s) вне кадра длиной %d", i+1, off, typ, len(f.data))
		}
		b := append([]byte(nil), f.data[off:off+size]...)
		if little {
			for a, z := 0, len(b)-1; a < z; a, z = a+1, z-1 {
				b[a], b[z] = b[z], b[a]
			}
		}
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
		format := formatOfType(typ)
		e.st.VarSetRuntime(fmt.Sprintf("%s.%d", mod, i+1), format, v)
		if name != "" {
			e.st.VarSetRuntime(name, format, v)
			e.st.VarSetRuntime(fmt.Sprintf("%s.%s", mod, name), format, v)
		}
	}
	return nil
}

func encodeValue(typ string, v float64, little bool) []byte {
	var b []byte
	switch typ {
	case "uint8", "int8":
		b = []byte{byte(int64(v))}
	case "bool":
		if v != 0 {
			b = []byte{1}
		} else {
			b = []byte{0}
		}
	case "uint16", "int16":
		b = binary.BigEndian.AppendUint16(nil, uint16(int64(v)))
	case "uint32", "int32":
		b = binary.BigEndian.AppendUint32(nil, uint32(int64(v)))
	case "float32":
		b = binary.BigEndian.AppendUint32(nil, math.Float32bits(float32(v)))
	}
	if little {
		for a, z := 0, len(b)-1; a < z; a, z = a+1, z-1 {
			b[a], b[z] = b[z], b[a]
		}
	}
	return b
}

func (e *Engine) subst(text string) (string, error) {
	for {
		i := strings.Index(text, "{")
		j := strings.Index(text, "}")
		if i < 0 || j < i {
			return text, nil
		}
		v, err := e.variable(text[i+1 : j])
		if err != nil {
			return "", err
		}
		text = text[:i] + strconv.FormatFloat(v, 'f', -1, 64) + text[j+1:]
	}
}

// payload builds the bytes for an RS-485 send block.
//
//	mode "table": rows {dataType, value, order}; value is a number, a variable name, or (dataType "text") a string with {variables}
func (e *Engine) payload(c map[string]interface{}) ([]byte, error) {
	mode := cfgStr(c, "mode", "table")
	if mode == "table" {
		rows, _ := c["rows"].([]interface{})
		if len(rows) == 0 {
			return nil, errors.New("таблица отправки пуста")
		}
		var out []byte
		for i, r := range rows {
			m, _ := r.(map[string]interface{})
			typ := cfgStr(m, "dataType", "uint8")
			val := strings.TrimSpace(cfgStr(m, "value", "0"))
			if typ == "text" {
				s, err := e.subst(val)
				if err != nil {
					return nil, err
				}
				out = append(out, []byte(strings.NewReplacer(`\r`, "\r", `\n`, "\n", `\t`, "\t").Replace(s))...)
				continue
			}
			if typeSize[typ] == 0 {
				return nil, fmt.Errorf("строка %d: неизвестный тип %q", i+1, typ)
			}
			f, err := strconv.ParseFloat(strings.Replace(val, ",", ".", 1), 64)
			if err != nil {
				if f, err = e.variable(val); err != nil {
					return nil, fmt.Errorf("строка %d: %v", i+1, err)
				}
			}
			out = append(out, encodeValue(typ, f, cfgStr(m, "order", "BE") == "LE")...)
		}
		return out, nil
	}
	text, err := e.subst(cfgStr(c, "data", ""))
	if err != nil {
		return nil, err
	}
	switch mode {
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
