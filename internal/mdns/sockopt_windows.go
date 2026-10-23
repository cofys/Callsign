//go:build windows

package mdns

import (
	"syscall"
)

// On Windows, SO_REUSEADDR on UDP multicast sockets provides equivalent port-sharing
// semantics to SO_REUSEPORT on Unix.
func reusePortControl(network, address string, c syscall.RawConn) error {
	var sockErr error
	err := c.Control(func(fd uintptr) {
		sockErr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	})
	if err != nil {
		return err
	}
	return sockErr
}
