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

// age's Bech32 human-readable parts, from the age specification (C2SP age.md).
// The identity HRP already ends in "-"; bech32's own separator "1" follows it,
// which is why every identity string begins "AGE-SECRET-KEY-1".
const (
	ageIdentityHRP  = "AGE-SECRET-KEY-"
	ageRecipientHRP = "age"
)

// Ed25519FromOKM maps a 32-octet leaf OKM onto an Ed25519 key (SPEC.md 7.1).
// The OKM is the seed verbatim: RFC 8032 hashes the seed to produce the scalar,
// so every 32-octet string is valid and there is no rejection sampling.
func Ed25519FromOKM(okm []byte) (ed25519.PrivateKey, error) {
	if len(okm) != ed25519.SeedSize {
		return nil, fmt.Errorf("derive: ed25519 needs %d octets, got %d", ed25519.SeedSize, len(okm))
	}
	return ed25519.NewKeyFromSeed(okm), nil
}

// AgeFromOKM maps a 32-octet leaf OKM onto an age X25519 identity and its
// recipient (SPEC.md 7.2). The identity octets are stored unclamped: RFC 7748's
// X25519 clamps internally, and the identity string carries the pre-clamp bytes
// exactly as age itself does.
func AgeFromOKM(okm []byte) (identity, recipient string, err error) {
	if len(okm) != 32 {
		return "", "", fmt.Errorf("derive: age identity needs 32 octets, got %d", len(okm))
	}
	priv, err := ecdh.X25519().NewPrivateKey(okm)
	if err != nil {
		return "", "", fmt.Errorf("derive: age identity: %w", err)
	}
	pub := priv.PublicKey().Bytes()
	// The abort SPEC.md sections 7.2 and 9 require: a recipient that is the
	// identity element would encrypt to everybody. crypto/ecdh does not check
	// it — it accepts an all-zero private key — so the check is written out
	// rather than assumed. RFC 7748's clamping makes it unreachable for
	// basepoint multiplication, since the clamped scalar is 2^254 + 8k and no
	// multiple of the group order in that range is divisible by 8. It stays
	// because that argument is about this one multiplication, not about X25519.
	if constant(pub, 0x00) {
		return "", "", errors.New("derive: age recipient is the identity element")
	}
	lower, err := bech32Encode(ageIdentityHRP, okm)
	if err != nil {
		return "", "", err
	}
	// Uppercase the whole string, checksum characters included. The checksum is
	// computed over the lowercase form; uppercasing afterwards is the only order
	// that yields a string other age implementations accept.
	identity = strings.ToUpper(lower)
	recipient, err = bech32Encode(ageRecipientHRP, pub)
	if err != nil {
		return "", "", err
	}
	return identity, recipient, nil
}

// AgeIdentityBytes is the inverse of AgeFromOKM's identity half, so a
// transcribed identity string can be checked against the tree without trusting
// the transcription. It is also the only caller of the Bech32 decoder, whose
// rejections are SPEC.md section 9.
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

// bip39WordlistSHA256 pins the English list by content rather than by URL
// (SPEC.md 7.3). Substituting another language's list would change every
// mnemonic while still producing 24 valid-looking words.
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

// MnemonicFromEntropy renders entropy as a BIP-39 mnemonic (SPEC.md 7.3). It
// emits the words and stops: BIP-39's mnemonic-to-seed PBKDF2 step, address
// derivation and every curve below it belong to real wallet software, and
// leaving them there is what keeps this tool standard-library-only.
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
	// ENT || the first CS bits of SHA-256(ENT), split into 11-bit groups,
	// most-significant bit first.
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
