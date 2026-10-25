package main

import (
	"bufio"
	"os"
	"strings"
)

// Config is read from the same file as the daemon (/etc/nexus/nexus.conf);
// keys the backend does not know are ignored (they belong to the daemon).
type Config struct {
	Socket   string // unix socket of nexusd
	Listen   string // HTTP listen address
	WWW      string // folder with the built web UI
	DataDir  string // persistent state (scenarios, module settings)
	UartDev  [2]string
	EthIface [2]string
}

func defaultConfig() Config {
	return Config{
		Socket:   "/var/run/nexus/daemon.sock",
		Listen:   "0.0.0.0:8080",
		WWW:      "/opt/nexus-iot/www",
		DataDir:  "/opt/nexus-iot/data",
		UartDev:  [2]string{"/dev/ttyS1", "/dev/ttyS2"},
		EthIface: [2]string{"eth0", "eth1"},
	}
}

func loadConfig(path string) Config {
	c := defaultConfig()
	f, err := os.Open(path)
	if err != nil {
		return c
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "socket":
			c.Socket = v
		case "listen":
			c.Listen = v
		case "www":
			c.WWW = v
		case "data":
			c.DataDir = v
		case "uart_dev1":
			c.UartDev[0] = v
		case "uart_dev2":
			c.UartDev[1] = v
		case "eth1":
			c.EthIface[0] = v
		case "eth2":
			c.EthIface[1] = v
		}
	}
	return c
}
