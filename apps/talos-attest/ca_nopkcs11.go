//go:build !cgo

package main

import (
	"errors"
	"os"
	"time"
)

func pkcs11Configured() bool { return os.Getenv("ATTEST_CA_PKCS11_MODULE") != "" }

// PKCS#11 modules load through cgo, so a build without it signs with the software key only.
func loadPKCS11CA(string, time.Duration) (*CA, error) {
	return nil, errors.New("ATTEST_CA_PKCS11_MODULE is set, but this talos-attest was built without cgo")
}
