package main

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"os"
)

// readBytes reads a file, or stdin when path is "-", so the rotation scripts
// can pipe PEM straight from Terraform output without a temp file.
func readBytes(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

// readCert loads exactly one certificate. More than one is an error rather than
// a silent first-wins: certs/ holds single-certificate files, and a bundle
// arriving where an anchor belongs is the kind of mistake worth stopping on.
func readCert(path string) (*x509.Certificate, error) {
	raw, err := readBytes(path)
	if err != nil {
		return nil, err
	}
	return parseCert(raw, path)
}

func parseCert(raw []byte, path string) (*x509.Certificate, error) {
	var found *x509.Certificate
	for rest := raw; len(rest) > 0; {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if found != nil {
			return nil, fmt.Errorf("%s: expected one certificate, found more", path)
		}
		found = cert
	}
	if found == nil {
		return nil, fmt.Errorf("%s: no certificate", path)
	}
	return found, nil
}

// readPrivateKey accepts PKCS#8, PKCS#1 and SEC1, which covers the Ed25519
// anchors and the RSA cluster material without asking the caller which is which.
func readPrivateKey(path string) (crypto.Signer, error) {
	raw, err := readBytes(path)
	if err != nil {
		return nil, err
	}
	return parseKey(raw, path)
}

func parseKey(raw []byte, path string) (crypto.Signer, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s: no PEM block", path)
	}
	var (
		key any
		err error
	)
	switch block.Type {
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(block.Bytes)
	default:
		return nil, fmt.Errorf("%s: unsupported PEM type %q", path, block.Type)
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("%s: key of type %T cannot sign", path, key)
	}
	return signer, nil
}

func writePEM(path, blockType string, der []byte, perm os.FileMode) error {
	encoded := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	return os.WriteFile(path, encoded, perm)
}

// spkiSHA256 hashes the DER SubjectPublicKeyInfo. kube-apiserver derives a
// ServiceAccount token's kid the same way, so this doubles as the JWKS kid
// source and as the identity used to prove a key still matches its certificate.
func spkiSHA256(pub crypto.PublicKey) ([32]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(der), nil
}

func keyAlgorithm(pub crypto.PublicKey) string {
	switch pub.(type) {
	case ed25519.PublicKey:
		return "Ed25519"
	case *rsa.PublicKey:
		return "RSA"
	default:
		return fmt.Sprintf("%T", pub)
	}
}
