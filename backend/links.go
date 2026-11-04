package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pollLinks detects the SD card. (Ethernet, modules, buttons and LEDs come from the daemon.)
func pollLinks(st *Store, cfg Config) {
	check := func() {
		st.SetLink("sdcard", sdPresent())
	}
	check()
	for range time.Tick(3 * time.Second) {
		check()
	}
}

// sdPresent: the board boots from the SD card (mmc0), so the card is "connected" when the MMC host has a card
// (/sys/class/mmc_host/mmc*/mmc*:*) or when any filesystem is mounted from /dev/mmcblk* (or the root device).
func sdPresent() bool {
	if m, _ := filepath.Glob("/sys/class/mmc_host/mmc*/mmc*:*"); len(m) > 0 {
		return true
	}
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "/dev/mmcblk") || strings.HasPrefix(l, "/dev/root ") {
			return true
		}
	}
	return false
}
