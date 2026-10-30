//go:build !linux

package main

import (
	"errors"
	"time"
)

func listenLLDP(string, time.Duration) (LLDP, error) {
	return LLDP{}, errors.New("an AF_PACKET socket needs Linux")
}
