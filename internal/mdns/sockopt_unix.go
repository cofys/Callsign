//go:build linux || darwin || freebsd || openbsd || netbsd

package mdns

import (
	"syscall"
)

// SO_REUSEPORT value is 0x0f (15) on Linux asm-generic and 0x0200 (512) on Darwin/BSD.
// Setting both SO_REUSEADDR and SO_REUSEPORT allows Callsign to coexist peacefully
// with avahi-daemon (Linux) and mDNSResponder (macOS) on UDP port 5353.
func reusePortControl(network, address string, c syscall.RawConn) error {
	var sockErr error
	err := c.Control(func(fd uintptr) {
		_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
		// Attempt both Linux (0xf) and BSD/macOS (0x0200) SO_REUSEPORT constants safely
		_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, 0xf, 1)
		_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, 0x0200, 1)
	})
	if err != nil {
		return err
	}
	return sockErr
}
