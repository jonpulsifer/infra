//go:build linux

package lldp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"syscall"
	"time"
	"unsafe"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// packetMreq is the kernel's struct packet_mreq.
type packetMreq struct {
	Ifindex int32
	Type    uint16
	Alen    uint16
	Address [8]byte
}

func htons(v uint16) uint16 {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], v)
	return binary.NativeEndian.Uint16(b[:])
}

// Listen reads the NIC's frames of the LLDP ethertype until one from the
// switch parses or wait passes. The socket joins the nearest-bridge group,
// which a NIC that filters multicast would drop. The attest action runs
// privileged in the host's network namespace, so it may open the socket.
func Listen(ifname string, wait time.Duration) (protocol.LLDP, error) {
	iface, err := net.InterfaceByName(ifname)
	if err != nil {
		return protocol.LLDP{}, err
	}
	proto := htons(etherTypeLLDP)
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, int(proto))
	if err != nil {
		return protocol.LLDP{}, fmt.Errorf("AF_PACKET socket: %w", err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: proto, Ifindex: iface.Index}); err != nil {
		return protocol.LLDP{}, fmt.Errorf("bind to %s: %w", ifname, err)
	}
	mreq := packetMreq{Ifindex: int32(iface.Index), Type: syscall.PACKET_MR_MULTICAST, Alen: 6}
	copy(mreq.Address[:], group[:])
	if _, _, errno := syscall.Syscall6(syscall.SYS_SETSOCKOPT, uintptr(fd), syscall.SOL_PACKET, syscall.PACKET_ADD_MEMBERSHIP,
		uintptr(unsafe.Pointer(&mreq)), unsafe.Sizeof(mreq), 0); errno != 0 {
		return protocol.LLDP{}, fmt.Errorf("join the LLDP group on %s: %w", ifname, errno)
	}
	deadline := time.Now().Add(wait)
	buf := make([]byte, 9216)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return protocol.LLDP{}, fmt.Errorf("no LLDP frame on %s in %s", ifname, wait)
		}
		// A zero timeout blocks for ever.
		tv := syscall.NsecToTimeval(max(left.Nanoseconds(), int64(time.Millisecond)))
		if err := syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv); err != nil {
			return protocol.LLDP{}, fmt.Errorf("receive timeout: %w", err)
		}
		n, from, err := syscall.Recvfrom(fd, buf, 0)
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return protocol.LLDP{}, fmt.Errorf("read %s: %w", ifname, err)
		}
		ll, ok := from.(*syscall.SockaddrLinklayer)
		if !ok || !fromSwitch(buf[:n], ll.Pkttype) {
			continue
		}
		if l, err := Parse(buf[:n]); err == nil {
			return l, nil
		}
	}
}
