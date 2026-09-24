// Package transcript writes the ceremony's public record.
//
// The transcript is published, so everything in it is public by construction:
// hashes, public keys, thresholds and procedure. TRANSCRIPT.md states the rule
// for deciding whether a new field belongs here; this file is that rule already
// applied, and the struct fields below are the whole schema.
//
// Entries are hash-chained as they are appended and written to disk after each
// one, so a ceremony that stops halfway leaves a shorter chain rather than no
// evidence. The document is signed once, off-gap, after the last entry -- see
// TRANSCRIPT.md for why an in-ceremony signature would prove nothing more.
package transcript

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/jcs"
)

// Schema names the document shape. apps/fml-attest refuses any other.
const Schema = "fml-ceremony/transcript/v1"

// Step names. Every entry is one of these; apps/fml-attest rejects the rest.
const (
	StepOpen        = "open"
	StepEntropy     = "entropy"
	StepShards      = "shards"
	StepLeaf        = "leaf"
	StepCertificate = "certificate"
	StepReserved    = "reserved"
	StepClose       = "close"
)

// Entry 0's prev. A fixed digest keeps every entry the same shape.
const genesis = "0000000000000000000000000000000000000000000000000000000000000000"

// Domain-separates the shard check from every other hash over the same secret.
const shardCheckTag = "fml-shard-check-v1"

// ShardCheck lets a quorum confirm a reconstituted secret before deriving from
// it. Publishing it is safe only because every sharded secret is 256 bits.
func ShardCheck(secret []byte) string {
	sum := sha256.Sum256(append([]byte(shardCheckTag), secret...))
	return hex.EncodeToString(sum[:])
}

// Open is entry 0: what ran, on what, and who vouches for it. Its hashes are
// operator assertions, as Notes says.
type Open struct {
	Notes                string `json:"notes"`
	SpecSHA256           string `json:"spec_sha256"`
	VCSRef               string `json:"vcs_ref"`
	Platform             string `json:"platform"`
	Toolchain            string `json:"toolchain"`
	Build                string `json:"build"`
	BinarySHA256         string `json:"binary_sha256"`
	ImageRef             string `json:"image_ref"`
	ImageSHA256          string `json:"image_sha256"`
	Hardware             string `json:"hardware"`
	Witnesses            int    `json:"witnesses"`
	SignerIdentity       string `json:"signer_identity"`
	SignerSSHFingerprint string `json:"signer_ssh_fingerprint"`
	SignatureNamespace   string `json:"signature_namespace"`
	AllowedSigners       string `json:"allowed_signers"`
	// The one instant the ceremony declares, and certificate notBefore. Entries
	// carry no timestamps: the chain gives their order.
	PinnedTime string `json:"pinned_time"`
}

// Source is one entropy contribution. WitnessSHA256 is omitted below the
// 128-bit min-entropy floor, where it would be a brute-force target.
type Source struct {
	Label          string `json:"label"`
	Bytes          int    `json:"bytes"`
	MinEntropyBits int    `json:"min_entropy_bits"`
	WitnessSHA256  string `json:"witness_sha256,omitempty"`
	// The six d6 face counts, for the dice source only.
	Tally []int `json:"tally,omitempty"`
}

type Entropy struct {
	Mix     string   `json:"mix"`
	Sources []Source `json:"sources"`
}

// Shards records one SLIP-39 share set. No field names or locates a holder.
type Shards struct {
	Secret            string `json:"secret"`
	Encoding          string `json:"encoding"`
	Threshold         int    `json:"threshold"`
	Shares            int    `json:"shares"`
	Extendable        bool   `json:"extendable"`
	IterationExponent int    `json:"iteration_exponent"`
	// SLIP-39's 15-bit set id, already on every share, so a holder can match a plate.
	Identifier  int    `json:"identifier"`
	CheckSHA256 string `json:"check_sha256"`
}

// Leaf is one derived key's public half. One of Public, Recipient or Words is
// set, by KeyType; a BIP-39 leaf records only its word count.
type Leaf struct {
	Path      string `json:"path"`
	KeyType   string `json:"key_type"`
	Public    string `json:"public,omitempty"`
	Recipient string `json:"recipient,omitempty"`
	Words     int    `json:"words,omitempty"`
}

// Certificate carries the base64 DER itself; a reader recomputes subject,
// serial and validity from it.
type Certificate struct {
	Role    string `json:"role"`
	KeyPath string `json:"key_path"`
	SHA256  string `json:"sha256"`
	DER     string `json:"der"`
}

// Reserved records branch names left unminted.
type Reserved struct {
	Names []string `json:"names"`
}

// Close ends the chain. Outcome is "complete" or "aborted". Attestations are
// procedural claims the signer vouches for and nobody can check.
type Close struct {
	Outcome      string   `json:"outcome"`
	Attestations []string `json:"attestations"`
}

// Transcript accumulates hash-chained entries.
type Transcript struct {
	ceremony string
	entries  []json.RawMessage
	digest   string
}

func New(ceremony string) *Transcript {
	return &Transcript{ceremony: ceremony, digest: genesis}
}

// Digest is the SHA-256 of the last entry's canonical bytes, which commits to
// every earlier entry. Witnesses record it after each step.
func (t *Transcript) Digest() string { return t.digest }

// Append canonicalises one entry, chains it and returns the new head.
func (t *Transcript) Append(step string, body any) (string, error) {
	if step == "" {
		return "", errors.New("transcript: entry with no step")
	}
	// Each entry is canonical on its own, so the hashed bytes are the ones a
	// reader recovers from the canonical document.
	c, err := jcs.Marshal(map[string]any{
		"seq":  len(t.entries),
		"step": step,
		"prev": t.digest,
		"body": body,
	})
	if err != nil {
		return "", fmt.Errorf("transcript: %w", err)
	}
	sum := sha256.Sum256(c)
	t.digest = hex.EncodeToString(sum[:])
	t.entries = append(t.entries, c)
	return t.digest, nil
}

// Bytes returns the canonical document to write, sign and publish. It has no
// trailing newline, because the signature covers the exact bytes.
func (t *Transcript) Bytes() ([]byte, error) {
	if len(t.entries) == 0 {
		return nil, errors.New("transcript: no entries")
	}
	return jcs.Marshal(map[string]any{
		"schema":   Schema,
		"ceremony": t.ceremony,
		"entries":  t.entries,
	})
}
