package fleet

import (
	"syscall"
	"unsafe"
)

// outq is SIOCOUTQ, which shares TIOCOUTQ's number: for a TCP socket, the
// bytes written and not yet acknowledged by the peer.
func outq(fd uintptr) (int, error) {
	var n int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCOUTQ, uintptr(unsafe.Pointer(&n))); e != 0 {
		return 0, e
	}
	return int(n), nil
}
