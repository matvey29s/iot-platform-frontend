package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func newTestEngine(t *testing.T) (*Engine, *Store) {
	cfg := defaultConfig()
	cfg.DataDir = t.TempDir()
	hub := NewHub()
	st := NewStore(cfg, hub)
	dc := NewDaemonClient("/nonexistent", st)
	return NewEngine(st, dc, hub), st
}

func put(t *testing.T, st *Store, g map[string]any) {
	b, _ := json.Marshal(g)
	st.mu.Lock()
	st.data.Scenarios["s"] = b
	st.mu.Unlock()
}

func node(id, typ string, cfg map[string]any) map[string]any {
	return map[string]any{"id": id, "data": map[string]any{"type": typ, "config": cfg}}
}
func edge(a, h, b string) map[string]any {
	return map[string]any{"source": a, "sourceHandle": h, "target": b}
}

func wait(t *testing.T, e *Engine, d time.Duration) {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if !e.Locked() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("scenario did not complete")
}

// gateway with two tasks; task 1: if X==1 -> LED 1 branch, then out -> delay; while loop counts via custom var
func TestGatewayIfWhile(t *testing.T) {
	e, st := newTestEngine(t)
	st.VarSetRuntime("X", "int", 1)
	put(t, st, map[string]any{"id": "s", "nodes": []any{
		node("g", "parallel_gateway", map[string]any{"tasks": 2, "priority": 1}),
		node("i", "if_else", map[string]any{"conditions": []any{
			map[string]any{"variable": "X", "operator": "==", "value": "2"},
			map[string]any{"variable": "X", "operator": "==", "value": "1"}}}),
		node("l1", "led_set", map[string]any{"led": 1, "state": "ON"}),
		node("l2", "led_set", map[string]any{"led": 2, "state": "ON"}),
		node("d", "delay", map[string]any{"ms": 50}),
		node("w", "while", map[string]any{"variable": "BTN-1", "operator": "==", "value": "1", "intervalMs": 10}),
	}, "edges": []any{
		edge("g", "t1", "i"), edge("g", "t2", "d"),
		edge("i", "c1", "l1"), edge("i", "c2", "l2"),
		edge("i", "out", "w"),
	}})
	if err := e.Start("s"); err != nil {
		t.Fatal(err)
	}
	wait(t, e, 3*time.Second)
	// the daemon is down: LED errors prove that only branch c2 (LED 2) ran
	st2 := e.Status()
	if st2.LastError == nil || !strings.Contains(*st2.LastError, "светодиод 2") {
		t.Fatalf("expected the LED-2 branch to run, got %v", st2.LastError)
	}
}

func TestNoStartBlock(t *testing.T) {
	e, st := newTestEngine(t)
	put(t, st, map[string]any{"id": "s", "nodes": []any{node("a", "delay", map[string]any{"ms": 1}), node("b", "delay", map[string]any{"ms": 1})},
		"edges": []any{edge("a", "out", "b"), edge("b", "out", "a")}})
	if e.Start("s") == nil {
		t.Fatal("cycle without start must be refused")
	}
}

func TestPayloadTable(t *testing.T) {
	e, st := newTestEngine(t)
	st.VarSetRuntime("T", "int", 258)
	b, err := e.payload(map[string]any{"mode": "table", "rows": []any{
		map[string]any{"dataType": "uint8", "value": "1"},
		map[string]any{"dataType": "uint16", "value": "T", "order": "BE"},
		map[string]any{"dataType": "uint16", "value": "T", "order": "LE"},
		map[string]any{"dataType": "text", "value": "ok{T}"}}})
	if err != nil || string(b) != "\x01\x01\x02\x02\x01ok258" {
		t.Fatalf("%q %v", b, err)
	}
}

func TestPrioGate(t *testing.T) {
	var g prioGate
	ctx := context.Background()
	g.acquire(ctx, 5)
	order := make(chan int, 2)
	go func() { g.acquire(ctx, 9); order <- 9; g.release() }()
	time.Sleep(20 * time.Millisecond)
	go func() { g.acquire(ctx, 1); order <- 1; g.release() }()
	time.Sleep(20 * time.Millisecond)
	g.release()
	if a := <-order; a != 1 {
		t.Fatalf("priority 1 must go first, got %d", a)
	}
}
