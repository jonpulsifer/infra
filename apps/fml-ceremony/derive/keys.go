package derive

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// age's Bech32 human-readable parts, from the C2SP age specification.
const (
	ageIdentityHRP  = "AGE-SECRET-KEY-"
	ageRecipientHRP = "age"
)

// Ed25519FromOKM uses the OKM as the seed verbatim. RFC 8032 hashes the seed, so
// every 32-octet string is a valid key.
func Ed25519FromOKM(okm []byte) (ed25519.PrivateKey, error) {
	if len(okm) != ed25519.SeedSize {
		return nil, fmt.Errorf("derive: ed25519 needs %d octets, got %d", ed25519.SeedSize, len(okm))
	}
	return ed25519.NewKeyFromSeed(okm), nil
}

// AgeFromOKM maps a 32-octet OKM onto an age X25519 identity and recipient. The
// identity keeps the unclamped bytes, as age does; X25519 clamps internally.
func AgeFromOKM(okm []byte) (identity, recipient string, err error) {
	if len(okm) != 32 {
		return "", "", fmt.Errorf("derive: age identity needs 32 octets, got %d", len(okm))
	}
	priv, err := ecdh.X25519().NewPrivateKey(okm)
	if err != nil {
		return "", "", fmt.Errorf("derive: age identity: %w", err)
	}
	pub := priv.PublicKey().Bytes()
	// An identity-element recipient would encrypt to everybody, and crypto/ecdh
	// does not reject one.
	if constant(pub, 0x00) {
		return "", "", errors.New("derive: age recipient is the identity element")
	}
	lower, err := bech32Encode(ageIdentityHRP, okm)
	if err != nil {
		return "", "", err
	}
	// The checksum covers the lowercase form, so uppercase only afterwards.
	identity = strings.ToUpper(lower)
	recipient, err = bech32Encode(ageRecipientHRP, pub)
	if err != nil {
		return "", "", err
	}
	return identity, recipient, nil
}

// AgeIdentityBytes inverts AgeFromOKM's identity half, so a transcribed identity
// can be checked against the tree.
func AgeIdentityBytes(identity string) ([]byte, error) {
	hrp, data, err := bech32Decode(identity)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(hrp, ageIdentityHRP) {
		return nil, fmt.Errorf("derive: %q is not an age identity", hrp)
	}
	if len(data) != 32 {
		return nil, fmt.Errorf("derive: age identity carries %d octets, want 32", len(data))
	}
	return data, nil
}

//go:embed bip39-english.txt
var bip39English string

// Pins the English wordlist by content. Another language's list would change
// every mnemonic and still give valid-looking words.
const bip39WordlistSHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

var bip39Words = sync.OnceValues(func() ([]string, error) {
	sum := sha256.Sum256([]byte(bip39English))
	if got := hex.EncodeToString(sum[:]); got != bip39WordlistSHA256 {
		return nil, fmt.Errorf("derive: BIP-39 wordlist SHA-256 is %s, want %s", got, bip39WordlistSHA256)
	}
	words := strings.Split(strings.TrimSuffix(bip39English, "\n"), "\n")
	if len(words) != 2048 {
		return nil, fmt.Errorf("derive: BIP-39 wordlist has %d entries, want 2048", len(words))
	}
	return words, nil
})

// MnemonicFromEntropy renders entropy as BIP-39 words. The PBKDF2 seed step and
// address derivation belong to wallet software.
func MnemonicFromEntropy(entropy []byte) (string, error) {
	bits := len(entropy) * 8
	if bits < 128 || bits > 256 || bits%32 != 0 {
		return "", fmt.Errorf("derive: BIP-39 entropy is %d bits, want 128-256 in steps of 32", bits)
	}
	words, err := bip39Words()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(entropy)
	cs := bits / 32
	// ENT || the first CS bits of SHA-256(ENT), in 11-bit groups, MSB first.
	total := bits + cs
	bit := func(i int) uint {
		if i < bits {
			return uint(entropy[i/8]>>(7-i%8)) & 1
		}
		i -= bits
		return uint(sum[i/8]>>(7-i%8)) & 1
	}
	out := make([]string, 0, total/11)
	for i := 0; i < total; i += 11 {
		idx := 0
		for j := 0; j < 11; j++ {
			idx = idx<<1 | int(bit(i+j))
		}
		out = append(out, words[idx])
	}
	return strings.Join(out, " "), nil
}
