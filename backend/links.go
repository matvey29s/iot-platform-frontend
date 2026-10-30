package main

import (
	"os"
	"strings"
	"time"
)

// pollLinks detects the SD card. (Ethernet, modules, buttons and LEDs come from the daemon.)
func pollLinks(st *Store, cfg Config) {
	check := func() {
		st.SetLink("sdcard", sdMounted())
	}
	check()
	for range time.Tick(3 * time.Second) {
		check()
	}
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
