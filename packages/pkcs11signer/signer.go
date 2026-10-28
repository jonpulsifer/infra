// Package pkcs11signer is a crypto.Signer whose private key stays on a PKCS#11 token, such as
// a YubiKey PIV slot through ykcs11. It finds the key whose public half matches a CA
// certificate, and opens the token again once when a signature fails.
package pkcs11signer

import (
	"bytes"
	"crypto"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/eclipse-keypont/crypto11"
)

// The environment contract of FromEnv.
const (
	EnvModule  = "ATTEST_CA_PKCS11_MODULE"
	EnvToken   = "ATTEST_CA_PKCS11_TOKEN"
	EnvPINFile = "ATTEST_CA_PKCS11_PIN_FILE"
	EnvCert    = "ATTEST_CA_CERT"
)

// Config names the module, the token by its label, the user PIN and the certificate whose key signs.
type Config struct {
	Module string
	Token  string
	PIN    string
	Cert   *x509.Certificate
}

// Signer signs with the token key that matches Config.Cert. It is safe for concurrent use.
type Signer struct {
	cfg Config

	mu     sync.RWMutex
	ctx    *crypto11.Context
	key    crypto.Signer
	gen    uint64
	closed bool
}

// Configured reports whether the environment selects a PKCS#11 CA key.
func Configured() bool {
	return os.Getenv(EnvModule) != ""
}

// ConfigFromEnv reads the module path, token label, PIN file and CA certificate file. The first
// certificate in the file is the CA's, so a chain file that starts with it also serves.
func ConfigFromEnv() (Config, error) {
	var missing []string
	get := func(name string) string {
		v := os.Getenv(name)
		if v == "" {
			missing = append(missing, name)
		}
		return v
	}
	module, token, pinFile, certFile := get(EnvModule), get(EnvToken), get(EnvPINFile), get(EnvCert)
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("pkcs11signer: unset: %s", strings.Join(missing, ", "))
	}
	pin, err := os.ReadFile(pinFile)
	if err != nil {
		return Config{}, fmt.Errorf("pkcs11signer: %s: %w", EnvPINFile, err)
	}
	cert, err := ReadCert(certFile)
	if err != nil {
		return Config{}, fmt.Errorf("pkcs11signer: %s: %w", EnvCert, err)
	}
	return Config{Module: module, Token: token, PIN: strings.TrimSpace(string(pin)), Cert: cert}, nil
}

// FromEnv opens the signer that ConfigFromEnv describes.
func FromEnv() (*Signer, error) {
	cfg, err := ConfigFromEnv()
	if err != nil {
		return nil, err
	}
	return Open(cfg)
}

// ReadCert returns the first certificate in a PEM file.
func ReadCert(path string) (*x509.Certificate, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for {
		var block *pem.Block
		block, raw = pem.Decode(raw)
		if block == nil {
			return nil, fmt.Errorf("%s holds no certificate", path)
		}
		if block.Type == "CERTIFICATE" {
			return x509.ParseCertificate(block.Bytes)
		}
	}
}

// Open logs in to the token and finds the key pair whose public key is Config.Cert's.
func Open(cfg Config) (*Signer, error) {
	if cfg.Module == "" || cfg.Token == "" || cfg.Cert == nil {
		return nil, errors.New("pkcs11signer: Module, Token and Cert are required")
	}
	if !cfg.Cert.IsCA || cfg.Cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("pkcs11signer: %s may not sign certificates", cfg.Cert.Subject)
	}
	s := &Signer{cfg: cfg}
	ctx, key, err := s.connect()
	if err != nil {
		return nil, err
	}
	s.ctx, s.key = ctx, key
	return s, nil
}

func (s *Signer) connect() (*crypto11.Context, crypto.Signer, error) {
	ctx, err := crypto11.Configure(&crypto11.Config{
		Path:       s.cfg.Module,
		TokenLabel: s.cfg.Token,
		Pin:        s.cfg.PIN,
		// A smart card answers one command at a time, so a larger pool only queues.
		MaxSessions: 2,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("pkcs11signer: token %q: %w", s.cfg.Token, err)
	}
	key, err := findKey(ctx, s.cfg.Cert)
	if err != nil {
		_ = ctx.Close()
		return nil, nil, fmt.Errorf("pkcs11signer: token %q: %w", s.cfg.Token, err)
	}
	return ctx, key, nil
}

func findKey(ctx *crypto11.Context, cert *x509.Certificate) (crypto.Signer, error) {
	keys, err := ctx.FindAllKeyPairs()
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		der, err := x509.MarshalPKIXPublicKey(k.Public())
		if err != nil {
			continue
		}
		if bytes.Equal(der, cert.RawSubjectPublicKeyInfo) {
			return k, nil
		}
	}
	return nil, fmt.Errorf("no key pair matches the public key of %s", cert.Subject)
}

// Certificate is the CA certificate whose key signs.
func (s *Signer) Certificate() *x509.Certificate { return s.cfg.Cert }

// Public is the CA certificate's public key.
func (s *Signer) Public() crypto.PublicKey { return s.cfg.Cert.PublicKey }

// Sign signs on the token. A failed signature opens the token again and retries once, because
// a YubiKey under PIN policy ONCE forgets its login when another client resets the card.
func (s *Signer) Sign(rand io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	s.mu.RLock()
	key, gen, closed := s.key, s.gen, s.closed
	s.mu.RUnlock()
	if closed {
		return nil, errClosed
	}
	var first error
	if key != nil {
		sig, err := key.Sign(rand, digest, opts)
		if err == nil {
			return sig, nil
		}
		first = err
	}
	if err := s.reopen(gen); err != nil {
		return nil, errors.Join(first, err)
	}
	s.mu.RLock()
	key = s.key
	s.mu.RUnlock()
	if key == nil {
		return nil, errClosed
	}
	return key.Sign(rand, digest, opts)
}

var errClosed = errors.New("pkcs11signer: closed")

// reopen replaces the context unless another caller already replaced generation gen. A failed
// reopen leaves no key, and the next Sign tries again.
func (s *Signer) reopen(gen uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errClosed
	}
	if s.gen != gen && s.key != nil {
		return nil
	}
	if s.ctx != nil {
		_ = s.ctx.Close()
	}
	s.ctx, s.key = nil, nil
	s.gen++
	ctx, key, err := s.connect()
	if err != nil {
		return err
	}
	s.ctx, s.key = ctx, key
	return nil
}

// Close logs out and releases the module. The Signer cannot sign afterwards.
func (s *Signer) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.ctx == nil {
		return nil
	}
	err := s.ctx.Close()
	s.ctx, s.key = nil, nil
	return err
}
