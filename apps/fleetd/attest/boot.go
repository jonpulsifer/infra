package attest

import (
	"context"
	"crypto/x509"
	"time"
)

// BootSession is an intake session whose signed confirm passed, which the
// verifier hands to Booted: the lab's boot image sends its later requests
// over it, each signed by the session's AK over its nonce. AK is the AK's
// PKIX DER.
type BootSession struct {
	ID      string
	Machine string
	Serial  string
	AK      []byte
	Nonce   []byte
	At      time.Time
}

// handOver gives Booted a confirmed intake session.
func (v *Verifier) handOver(ctx context.Context, id string, s *session) {
	if v.Booted == nil || s.ak == nil {
		return
	}
	der, err := x509.MarshalPKIXPublicKey(s.ak.Public)
	if err != nil {
		v.Log.Error("boot session: the AK does not marshal", "machine", s.machine.Name, "err", err)
		return
	}
	v.Booted(ctx, BootSession{ID: id, Machine: s.machine.Name, Serial: s.machine.Serial, AK: der, Nonce: append([]byte{}, s.nonce...), At: v.Now()})
}
