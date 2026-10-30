//go:build !linux

package lldp

import (
	"errors"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// Listen needs an AF_PACKET socket.
func Listen(string, time.Duration) (protocol.LLDP, error) {
	return protocol.LLDP{}, errors.New("an AF_PACKET socket needs Linux")
}
