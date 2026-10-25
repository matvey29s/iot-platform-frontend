package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pollLinks detects what the backend can see itself: Ethernet carrier, USB
// devices, SD card. (Module slots come from the daemon.) Audio jacks have no
// presence signal on Linux, so they are reported as not connected.
func pollLinks(st *Store, cfg Config) {
	check := func() {
		st.SetLink("ethernet1", carrier(cfg.EthIface[0]))
		st.SetLink("ethernet2", carrier(cfg.EthIface[1]))
		st.SetLink("usb", usbDevices())
		st.SetLink("sdcard", sdMounted())
		st.SetLink("audioIn", false)
		st.SetLink("audioOut", false)
	}
	check()
	for range time.Tick(3 * time.Second) {
		check()
	}
}

func carrier(iface string) bool {
	if iface == "" {
		return false
	}
	b, err := os.ReadFile("/sys/class/net/" + iface + "/carrier")
	return err == nil && strings.TrimSpace(string(b)) == "1"
}

// real USB devices are named like "1-1"; root hubs are "usb1".
func usbDevices() bool {
	ents, _ := filepath.Glob("/sys/bus/usb/devices/[0-9]*-[0-9]*")
	for _, e := range ents {
		if !strings.Contains(filepath.Base(e), ":") { // skip interfaces "1-1:1.0"
			return true
		}
	}
	return false
}

func sdMounted() bool {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "/dev/mmcblk") {
			return true
		}
	}
	return false
}
