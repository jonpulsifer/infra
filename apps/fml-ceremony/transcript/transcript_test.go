package transcript

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/certs"
	"github.com/jonpulsifer/infra/apps/fml-ceremony/entropy"
	"github.com/jonpulsifer/infra/apps/fml-ceremony/slip39"
)

var update = flag.Bool("update", false, "rewrite the golden transcript fixture")

// goldenPath is read by apps/fml-attest's tests too. One file, written here and
// verified there, is what stops the writer and the independent reader from
// drifting apart while both keep passing their own tests.
const goldenPath = "../testdata/transcript.example.json"

func TestChain(t *testing.T) {
	tr := New("test")
	if tr.Digest() != genesis {
		t.Fatalf("fresh transcript head = %s, want the genesis digest", tr.Digest())
	}
	first, err := tr.Append(StepReserved, Reserved{Names: []string{"fml/kms"}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := tr.Append(StepClose, Close{Outcome: "aborted", Attestations: []string{"rehearsal"}})
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two entries produced the same head")
	}
	raw, err := tr.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Entries []json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	// Each entry's prev is the previous entry's digest, and each entry's bytes
	// inside the canonical document hash to the head that was returned when it
	// was appended. Both halves have to hold or a reader cannot replay the chain.
	prev := genesis
	for i, e := range doc.Entries {
		var got struct {
			Seq  int    `json:"seq"`
			Prev string `json:"prev"`
		}
		if err := json.Unmarshal(e, &got); err != nil {
			t.Fatal(err)
		}
		if got.Seq != i || got.Prev != prev {
			t.Fatalf("entry %d: seq=%d prev=%s, want seq=%d prev=%s", i, got.Seq, got.Prev, i, prev)
		}
		sum := sha256.Sum256(e)
		prev = hex.EncodeToString(sum[:])
	}
	if prev != second {
		t.Fatalf("replayed head = %s, want %s", prev, second)
	}
}

func TestShardCheckIsStable(t *testing.T) {
	// Pinned so a change to the tag or the construction shows up as a test
	// failure rather than as a recovery quorum that cannot confirm its secret.
	const wantZero = "650073a5dfe8c506fb77fa5f970ee7074a85d60b5b4bff9094c7de5955babca3"
	if got := ShardCheck(make([]byte, 32)); got != wantZero {
		t.Fatalf("ShardCheck(zero32) = %s, want %s", got, wantZero)
	}
	if ShardCheck(make([]byte, 32)) == ShardCheck(bytes.Repeat([]byte{1}, 32)) {
		t.Fatal("different secrets produced the same check digest")
	}
}

func TestBytesRefusesAnEmptyTranscript(t *testing.T) {
	if _, err := New("test").Bytes(); err == nil {
		t.Fatal("an entryless transcript produced a document")
	}
}

// TestGoldenTranscript builds the published rehearsal fixture and compares it
// byte for byte. Regenerate with `go test ./transcript -update`.
//
// It is a rehearsal on SPEC.md's vector A -- the all-zero master, whose derived
// public halves are published in section 11 -- so a reader can check every key
// in the fixture against the spec by hand.
func TestGoldenTranscript(t *testing.T) {
	got, err := buildRehearsal(t)
	if err != nil {
		t.Fatal(err)
	}
	if *update {
		if err := os.WriteFile(goldenPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d bytes)", goldenPath, len(got))
		return
	}
	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is not the canonical document this package produces; rerun with -update. "+
			"A trailing newline is the usual cause: the file is signed as-is and must not have one.", goldenPath)
	}
}

// Vector A of SPEC.md section 11, verbatim.
const (
	vecMaster       = "0000000000000000000000000000000000000000000000000000000000000000"
	vecInfraSecret  = "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37"
	vecWalletSecret = "c5c1acdd22bc15d597a801efed2838e5cebcdfd6040fb6f98afc55e5f752c2c7"
	vecRootSeed     = "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c"
	vecRootPub      = "58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03"
	vecIntSeed      = "81686d1cb25f96f91efdb5158468278dab9e5c88fb6073e2bccf51da31bf6087"
	vecIntPub       = "5f017b89fc0875aa4f481e5a2e04f7afb9b246ae5bab905832f2ae126f9a20fd"
	vecAgeRecipient = "age1uzf08nsuz0gwuz9ue0f80re672nfawute7ln8g2ys4vpyg60uu7skcqfru"
	pinnedTime      = "2026-08-26T00:00:00Z"
	rootPath        = "fml/infra/v1/pki/root/v1"
	intPath         = "fml/infra/v1/pki/intermediate/v1"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func buildRehearsal(t *testing.T) ([]byte, error) {
	t.Helper()
	tr := New("rehearsal-spec-vector-a")

	if _, err := tr.Append(StepOpen, Open{
		Notes: "REHEARSAL FIXTURE, NOT A CEREMONY. The master is SPEC.md section 11 " +
			"vector A, the published all-zero seed, so every key below is public by " +
			"construction and checkable against the spec. The entropy entry is " +
			"fabricated for the fixture; no entropy was collected and no shares exist. " +
			"A valid signature on a real transcript proves only that the holder of the " +
			"named SSH key vouches for those exact bytes. It does not prove which binary " +
			"produced them: no hardware on the ceremony host measured the running code, " +
			"so every *_sha256 field is an operator assertion, not a measurement.",
		SpecSHA256:           strings.Repeat("00", 32),
		VCSRef:               "0000000000000000000000000000000000000000",
		Platform:             "linux/amd64",
		Toolchain:            "go1.27.0",
		Build:                "CGO_ENABLED=0 go build -trimpath -buildvcs=false ./...",
		BinarySHA256:         strings.Repeat("00", 32),
		ImageRef:             ".#packages.x86_64-linux.ceremony",
		ImageSHA256:          strings.Repeat("00", 32),
		Hardware:             "rehearsal fixture, no hardware",
		Witnesses:            2,
		SignerIdentity:       "jonathan@pulsifer.ca",
		SignerSSHFingerprint: "SHA256:irAaZjbawI58jsAh8EJToey1bV8EA6xIajW8LJWJMiI",
		SignatureNamespace:   "fml-ceremony-transcript",
		AllowedSigners:       "apps/fml-ceremony/allowed_signers",
		PinnedTime:           pinnedTime,
	}); err != nil {
		return nil, err
	}

	dice, tally, err := entropy.Dice(strings.Repeat("123456", 16) + "1234")
	if err != nil {
		return nil, err
	}
	// Fixture bytes, not a real contribution: a fixed pattern and a constant
	// carry no entropy at all. So this fixture claims none and publishes NO
	// witness digest -- a digest of a guessable contribution is a brute-force
	// target, not a witness, and this is the document a real transcript will be
	// copied from. It must demonstrate the floor rule rather than teach a
	// reader to walk past it.
	kernel := entropy.Source{Label: "kernel-csprng", Bytes: bytes.Repeat([]byte{0x5a}, 32)}
	if _, err := tr.Append(StepEntropy, Entropy{
		Mix: "fml-entropy-mix-v1",
		Sources: []Source{
			{
				Label:          dice.Label,
				Bytes:          len(dice.Bytes),
				MinEntropyBits: 0,
				Tally:          tally[:],
			},
			{
				Label:          kernel.Label,
				Bytes:          len(kernel.Bytes),
				MinEntropyBits: 0,
			},
		},
	}); err != nil {
		return nil, err
	}

	// The identifier is DERIVED, never transcribed. A literal here would be an
	// invented number sitting unmarked beside verified ones, in the one artifact
	// a stranger is told to check -- and a wrong identifier makes a correct plate
	// fail the very check the field exists for.
	for _, s := range []struct {
		secret            string
		bytes             string
		threshold, shares int
	}{
		{"master", vecMaster, 3, 5},
		{"fml/infra/v1", vecInfraSecret, 2, 3},
		{"fml/wallet/v1", vecWalletSecret, 2, 3},
	} {
		secret := mustHex(t, s.bytes)
		id, err := slip39.Identifier(secret, s.threshold, s.shares)
		if err != nil {
			return nil, err
		}
		if _, err := tr.Append(StepShards, Shards{
			Secret:            s.secret,
			Encoding:          "slip39",
			Threshold:         s.threshold,
			Shares:            s.shares,
			Extendable:        true,
			IterationExponent: 0,
			Identifier:        int(id),
			CheckSHA256:       ShardCheck(secret),
		}); err != nil {
			return nil, err
		}
	}

	for _, l := range []Leaf{
		{Path: rootPath, KeyType: "ed25519", Public: vecRootPub},
		{Path: intPath, KeyType: "ed25519", Public: vecIntPub},
		{Path: "fml/infra/v1/age/operator/v1", KeyType: "x25519-age", Recipient: vecAgeRecipient},
		{Path: "fml/wallet/v1/cold/v1", KeyType: "bip39", Words: 24},
	} {
		if _, err := tr.Append(StepLeaf, l); err != nil {
			return nil, err
		}
	}

	rootDER := mintCA(t, vecRootSeed, "Folly Mountain Laboratories Root CA", nil, "")
	root, err := x509.ParseCertificate(rootDER)
	if err != nil {
		return nil, err
	}
	intDER := mintCA(t, vecIntSeed, "Folly Mountain Laboratories Intermediate CA", root, vecRootSeed)
	for _, c := range []struct {
		role, keyPath string
		der           []byte
	}{
		{"root", rootPath, rootDER},
		{"intermediate", intPath, intDER},
	} {
		sum := sha256.Sum256(c.der)
		if _, err := tr.Append(StepCertificate, Certificate{
			Role:    c.role,
			KeyPath: c.keyPath,
			SHA256:  hex.EncodeToString(sum[:]),
			DER:     base64.StdEncoding.EncodeToString(c.der),
		}); err != nil {
			return nil, err
		}
	}

	if _, err := tr.Append(StepReserved, Reserved{Names: []string{"fml/kms", "fml/ssh"}}); err != nil {
		return nil, err
	}
	if _, err := tr.Append(StepClose, Close{
		Outcome: "complete",
		Attestations: []string{
			"This is a rehearsal fixture. No ceremony took place and no share exists.",
		},
	}); err != nil {
		return nil, err
	}
	return tr.Bytes()
}

// mintCA builds the fixture's certificates through the ceremony's own
// deterministic profile, so the fixture exercises the certificate a real
// ceremony would mint rather than a lookalike. Reproducible by construction:
// certs.SelfSigned refuses a randomness source, the serial is derived from the
// key, and notBefore is the transcript's pinned instant.
func mintCA(t *testing.T, seedHex, cn string, parent *x509.Certificate, parentSeedHex string) []byte {
	t.Helper()
	key := ed25519.NewKeyFromSeed(mustHex(t, seedHex))
	subject, err := asn1.Marshal(pkix.Name{CommonName: cn}.ToRDNSequence())
	if err != nil {
		t.Fatal(err)
	}
	notBefore, err := time.Parse(time.RFC3339, pinnedTime)
	if err != nil {
		t.Fatal(err)
	}
	profile := certs.Profile{
		RawSubject: subject,
		NotBefore:  notBefore,
		NotAfter:   certs.NoExpiry,
	}
	var der []byte
	if parent == nil {
		profile.Path, profile.MaxPathLen = rootPath, 2
		der, err = certs.SelfSigned(key, profile)
	} else {
		profile.Path, profile.MaxPathLen = intPath, 1
		der, err = certs.SignedBy(key, profile, parent, ed25519.NewKeyFromSeed(mustHex(t, parentSeedHex)))
	}
	if err != nil {
		t.Fatal(err)
	}
	return der
}
