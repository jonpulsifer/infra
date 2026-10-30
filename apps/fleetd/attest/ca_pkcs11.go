//go:build cgo

package attest

import (
	"time"

	"github.com/jonpulsifer/infra/packages/pkcs11signer"
)

func pkcs11Configured() bool { return pkcs11signer.Configured() }

// loadPKCS11CA signs on the token that ATTEST_CA_PKCS11_* names. ATTEST_CA_CERT selects the key and
// must be the first certificate of the chain.
func loadPKCS11CA(chainPath string, validity time.Duration) (*CA, error) {
	signer, err := pkcs11signer.FromEnv()
	if err != nil {
		return nil, err
	}
	chain, err := readChain(chainPath)
	if err != nil {
		_ = signer.Close()
		return nil, err
	}
	ca, err := NewCA(signer, chain, validity)
	if err != nil {
		_ = signer.Close()
		return nil, err
	}
	return ca, nil
}
