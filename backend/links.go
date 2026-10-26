package main

import (
	"os"
	"strings"
	"time"
)

// pollLinks detects what the backend can see itself: Ethernet carrier and the
// SD card. (Modules, buttons and LEDs come from the daemon.)
func pollLinks(st *Store, cfg Config) {
	check := func() {
		st.SetLink("ethernet1", carrier(cfg.EthIface[0]))
		st.SetLink("sdcard", sdMounted())
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
