package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
)

// TPM 2.0 Part 2 constants for the TPMT_PUBLIC fields this reads.
const (
	algRSA    = 0x0001
	algNull   = 0x0010
	algRSAES  = 0x0015
	algECC    = 0x0023
	algECDAA  = 0x001a
	attrSign  = 1 << 18
	curveP256 = 0x0003
	curveP384 = 0x0004
	curveP521 = 0x0005
)

type reader struct {
	b   []byte
	err error
}

func (r *reader) next(n int) []byte {
	if r.err != nil {
		return nil
	}
	if len(r.b) < n {
		r.err = errors.New("the TPMT_PUBLIC is truncated")
		return nil
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func (r *reader) u16() uint16 {
	if v := r.next(2); v != nil {
		return binary.BigEndian.Uint16(v)
	}
	return 0
}

func (r *reader) u32() uint32 {
	if v := r.next(4); v != nil {
		return binary.BigEndian.Uint32(v)
	}
	return 0
}

func (r *reader) sized() []byte { return r.next(int(r.u16())) }

// alg reads an algorithm ID and its details when it is not TPM_ALG_NULL.
func (r *reader) alg(details func(uint16) int) {
	if a := r.u16(); a != algNull {
		r.next(details(a))
	}
}

func hashOnly(uint16) int { return 2 }

// parsePublic reads the signing key out of a TPMT_PUBLIC, the public blob that
// SPIRE's tpm_devid plugin loads.
func parsePublic(b []byte) (any, error) {
	r := &reader{b: b}
	typ := r.u16()
	r.u16() // nameAlg
	attrs := r.u32()
	r.sized()                            // authPolicy
	r.alg(func(uint16) int { return 4 }) // symmetric: keyBits, mode
	var key any
	switch typ {
	case algRSA:
		r.alg(func(a uint16) int {
			if a == algRSAES {
				return 0
			}
			return 2
		})
		r.u16() // keyBits
		exp := r.u32()
		mod := r.sized()
		if exp == 0 {
			exp = 65537
		}
		key = &rsa.PublicKey{N: new(big.Int).SetBytes(mod), E: int(exp)}
	case algECC:
		r.alg(func(a uint16) int {
			if a == algECDAA {
				return 4
			}
			return 2
		})
		curveID := r.u16()
		r.alg(hashOnly) // kdf
		x, y := r.sized(), r.sized()
		if r.err != nil {
			return nil, r.err
		}
		k, err := eccKey(curveID, x, y)
		if err != nil {
			return nil, err
		}
		key = k
	default:
		return nil, fmt.Errorf("key type 0x%04x is neither RSA nor ECC", typ)
	}
	if r.err != nil {
		return nil, r.err
	}
	if attrs&attrSign == 0 {
		return nil, errors.New("the key cannot sign, so SPIRE refuses it")
	}
	return key, nil
}

func eccKey(curveID uint16, x, y []byte) (*ecdsa.PublicKey, error) {
	var curve elliptic.Curve
	switch curveID {
	case curveP256:
		curve = elliptic.P256()
	case curveP384:
		curve = elliptic.P384()
	case curveP521:
		curve = elliptic.P521()
	default:
		return nil, fmt.Errorf("unsupported ECC curve 0x%04x", curveID)
	}
	size := (curve.Params().BitSize + 7) / 8
	if len(x) > size || len(y) > size {
		return nil, errors.New("the ECC point is larger than its curve")
	}
	point := make([]byte, 1+2*size)
	point[0] = 4
	copy(point[1+size-len(x):1+size], x)
	copy(point[1+2*size-len(y):], y)
	return ecdsa.ParseUncompressedPublicKey(curve, point)
}
