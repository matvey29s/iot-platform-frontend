// nexus-backend: HTTP/REST + SSE server for the Nexus IoT Platform UI.
// It serves the built frontend, talks to the C daemon (nexusd) over a unix
// socket and keeps no hardware logic of its own. Standard library only.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"
)

func main() {
	conf := flag.String("c", "/etc/nexus/nexus.conf", "config file")
	flag.Parse()
	cfg := loadConfig(*conf)

	hub := NewHub()
	st := NewStore(cfg, hub)
	dc := NewDaemonClient(cfg.Socket, st)
	go dc.Run()
	go pollLinks(st, cfg)

	api := &API{st: st, dc: dc, hub: hub, cfg: cfg}
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           api.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// no WriteTimeout: /api/events is a long-lived stream
	}
	log.Printf("nexus-backend listening on %s, www=%s, daemon=%s", cfg.Listen, cfg.WWW, cfg.Socket)
	log.Fatal(srv.ListenAndServe())
}
