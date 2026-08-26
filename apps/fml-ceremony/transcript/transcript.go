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

// Schema names the document shape. apps/fml-attest refuses anything else
// rather than guessing which fields a future version moved.
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

// genesis is entry 0's prev. A fixed all-zero digest rather than an omitted
// field, so every entry has the same shape and the chain check has no special
// case to get wrong.
const genesis = "0000000000000000000000000000000000000000000000000000000000000000"

// shardCheckTag domain-separates the shard check digest from the derivation's
// HKDF inputs and from the entropy witness digests. Without a tag distinct from
// every other hash over the same secret, publishing this digest could hand an
// implementation bug somewhere else a matching value to compare against.
const shardCheckTag = "fml-shard-check-v1"

// ShardCheck is the digest published for a sharded secret: enough for a quorum
// that has just reconstituted one to confirm they rebuilt the right thing,
// before deriving anything from it.
//
// Safe to publish only because every sharded secret here is a full 256 bits, so
// the digest is a 2^256 target rather than a guessable one -- the same floor
// the entropy package applies to source witnesses. The wallet leaf deliberately
// gets no equivalent: its branch already carries one, and a second digest would
// only add a way to confirm a candidate wallet belongs to this estate.
func ShardCheck(secret []byte) string {
	sum := sha256.Sum256(append([]byte(shardCheckTag), secret...))
	return hex.EncodeToString(sum[:])
}

// Open is entry 0: what ran, under what, and who is accountable for saying so.
// Every hash here is an operator assertion rather than a measurement, which is
// what Notes says in the words the transcript publishes.
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
	// PinnedTime is the one instant the ceremony declares. Certificate
	// notBefore comes from here and not from the clock, so a certificate can be
	// minted twice and compared byte for byte; an air-gapped host has no NTP and
	// its RTC is not evidence of anything. Entries carry no timestamps of their
	// own: order comes from the chain, which is checkable, and a per-entry clock
	// reading is not.
	PinnedTime string `json:"pinned_time"`
}

// Source is one entropy contribution. Bytes and MinEntropyBits describe the
// contribution; WitnessSHA256 proves it took part without publishing it, and is
// omitted for a source below the 128-bit floor where the digest would be a
// brute-force target instead of a witness.
type Source struct {
	Label          string `json:"label"`
	Bytes          int    `json:"bytes"`
	MinEntropyBits int    `json:"min_entropy_bits"`
	WitnessSHA256  string `json:"witness_sha256,omitempty"`
	// Tally is the six d6 face counts, present only for the dice source. It is
	// the number the operator compares against their own paper worksheet, so a
	// reader can see the comparison was possible.
	Tally []int `json:"tally,omitempty"`
}

type Entropy struct {
	Mix     string   `json:"mix"`
	Sources []Source `json:"sources"`
}

// Shards records one SLIP-39 share set. Thresholds and set identity only:
// nothing here names or locates a holder, and no field in this schema can.
type Shards struct {
	Secret            string `json:"secret"`
	Encoding          string `json:"encoding"`
	Threshold         int    `json:"threshold"`
	Shares            int    `json:"shares"`
	Extendable        bool   `json:"extendable"`
	IterationExponent int    `json:"iteration_exponent"`
	// Identifier is SLIP-39's 15-bit set id. It is printed on every share of
	// the set already, so publishing it leaks nothing and lets a holder confirm
	// the plate in their hand belongs to this ceremony.
	Identifier  int    `json:"identifier"`
	CheckSHA256 string `json:"check_sha256"`
}

// Leaf is one derived key, as its public half. Exactly one of Public,
// Recipient or Words is set, by KeyType; a BIP-39 leaf has no public half at
// all and records only that it was minted.
type Leaf struct {
	Path      string `json:"path"`
	KeyType   string `json:"key_type"`
	Public    string `json:"public,omitempty"`
	Recipient string `json:"recipient,omitempty"`
	Words     int    `json:"words,omitempty"`
}

// Certificate carries the certificate itself, base64 DER, rather than facts
// about it. Subject, serial and validity are all inside the DER and a reader
// recomputes them; restating them here would only create something to disagree
// with. Base64 rather than PEM because the verifier then needs no PEM decoder.
type Certificate struct {
	Role    string `json:"role"`
	KeyPath string `json:"key_path"`
	SHA256  string `json:"sha256"`
	DER     string `json:"der"`
}

// Reserved records branch names that were deliberately not minted, so reading
// the transcript tells you what was left out on purpose.
type Reserved struct {
	Names []string `json:"names"`
}

// Close terminates the chain. Outcome is "complete" or "aborted": an abandoned
// ceremony is published as an abandoned ceremony, which is the only way a
// reader can tell the difference from a ceremony that was never published.
// Attestations are procedural claims the signer is accountable for and nobody
// can check -- apps/fml-attest prints them under a heading that says so.
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

// Digest is the running head: the SHA-256 of the last entry's canonical bytes,
// and through its prev field a commitment to every entry before it. The
// ceremony reads it aloud after each step so witnesses can write it down. That
// is the whole defence against a ceremony being run twice and only the
// convenient run published -- a witness holding a digest that appears in no
// published chain is holding a contradiction.
func (t *Transcript) Digest() string { return t.digest }

// Append canonicalises one entry, chains it and returns the new head.
func (t *Transcript) Append(step string, body any) (string, error) {
	if step == "" {
		return "", errors.New("transcript: entry with no step")
	}
	// Canonicalise per entry as well as per document. The chain hashes entry
	// bytes, so those bytes have to be the same ones a reader recovers from the
	// canonical document, and canonical form is recursive.
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

// Bytes returns the canonical document: the exact bytes to write to disk, to
// sign, and to publish. There is no trailing newline, deliberately -- the
// signature covers the file as it is, and a newline an editor added is a
// signature that no longer verifies.
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
