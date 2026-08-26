// Command fml-attest checks a Folly Mountain Laboratories ceremony transcript.
//
// It is deliberately small, and it is deliberately incapable. Its only input is
// the path to a transcript; it reads no other file, writes no file, opens no
// network connection, and contains no code that reads, derives, stores or emits
// a private key. There is nothing you could hand it that would make it touch a
// secret, which is what makes it safe for a stranger to run on their own
// machine -- and running it on your own machine is the point, because a
// verifier you have to trust someone else to run verifies nothing.
//
// It does not check the transcript's signature. Signature checking is
// `ssh-keygen -Y verify`, which every reader already has and already trusts;
// the Go standard library has no SSH support, so verifying SSHSIG here would
// mean hand-rolling SSH wire format inside the one artifact whose whole value
// is being too small to hide a bug in. This tool prints the exact command
// instead.
//
// The full procedure -- rebuild, compare, verify, replay -- is in
// apps/fml-ceremony/TRANSCRIPT.md.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fml-ceremony/jcs"
)

const (
	schema  = "fml-ceremony/transcript/v1"
	genesis = "0000000000000000000000000000000000000000000000000000000000000000"
	// witnessFloorBits mirrors the entropy package's rule: a digest of a
	// contribution below this is a brute-force target, not a witness.
	// Enforced here rather than assumed.
	witnessFloorBits = 128
)

// reservedBranches mint nothing, so nothing may be derived under them. A
// transcript showing a key under one describes material with no share set,
// which is the exact failure the two-tier quorum exists to prevent.
var reservedBranches = []string{"fml/kms", "fml/ssh"}

func main() {
	if len(os.Args) != 2 || strings.HasPrefix(os.Args[1], "-") {
		fmt.Fprint(os.Stderr, "usage: fml-attest <transcript.json>\n\n"+
			"Checks what the transcript proves and prints what it only asserts. Does not\n"+
			"check the signature: use ssh-keygen -Y verify, as printed.\n")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "fml-attest: %v\n", err)
		os.Exit(2)
	}
	if err := verify(os.Stdout, os.Args[1], raw); err != nil {
		fmt.Fprintf(os.Stderr, "fml-attest: %v\n", err)
		os.Exit(1)
	}
}

type document struct {
	Schema   string            `json:"schema"`
	Ceremony string            `json:"ceremony"`
	Entries  []json.RawMessage `json:"entries"`
}

type entry struct {
	Seq  int             `json:"seq"`
	Step string          `json:"step"`
	Prev string          `json:"prev"`
	Body json.RawMessage `json:"body"`
}

// The body types are declared here rather than imported from the writer on
// purpose. An independent reader is the point: sharing one struct would mean a
// field the writer stopped emitting kept passing.
type openBody struct {
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
	PinnedTime           string `json:"pinned_time"`
}

type sourceBody struct {
	Label          string `json:"label"`
	Bytes          int    `json:"bytes"`
	MinEntropyBits int    `json:"min_entropy_bits"`
	WitnessSHA256  string `json:"witness_sha256"`
	Tally          []int  `json:"tally"`
}

type entropyBody struct {
	Mix     string       `json:"mix"`
	Sources []sourceBody `json:"sources"`
}

type shardsBody struct {
	Secret            string `json:"secret"`
	Encoding          string `json:"encoding"`
	Threshold         int    `json:"threshold"`
	Shares            int    `json:"shares"`
	Extendable        bool   `json:"extendable"`
	IterationExponent int    `json:"iteration_exponent"`
	Identifier        int    `json:"identifier"`
	CheckSHA256       string `json:"check_sha256"`
}

type leafBody struct {
	Path      string `json:"path"`
	KeyType   string `json:"key_type"`
	Public    string `json:"public"`
	Recipient string `json:"recipient"`
	Words     int    `json:"words"`
}

type certBody struct {
	Role    string `json:"role"`
	KeyPath string `json:"key_path"`
	SHA256  string `json:"sha256"`
	DER     string `json:"der"`
}

type reservedBody struct {
	Names []string `json:"names"`
}

type closeBody struct {
	Outcome      string   `json:"outcome"`
	Attestations []string `json:"attestations"`
}

// ceremony is the whole transcript, decoded once. Every check below reads this
// rather than the JSON, so each entry is parsed exactly one time and no check
// can disagree with another about what the document says.
type ceremony struct {
	open     openBody
	closing  closeBody
	mix      string
	sources  []sourceBody
	shards   []shardsBody
	leaves   map[string]leafBody
	certs    []certBody
	reserved []string
	steps    []string
}

// strict decodes with unknown fields refused. That refusal is the schema's
// "public by design" claim made mechanical: a transcript cannot smuggle a field
// past this tool, so anything a reader finds in one is a field declared here
// and reviewed as publishable.
func strict(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func verify(w io.Writer, name string, raw []byte) error {
	canonical, err := jcs.Canonical(raw)
	if err != nil {
		return fmt.Errorf("%s is not JSON: %w", name, err)
	}
	var doc document
	if err := strict(canonical, &doc); err != nil {
		return fmt.Errorf("%s does not match the transcript schema: %w", name, err)
	}
	sum := sha256.Sum256(canonical)
	fmt.Fprintf(w, "transcript  %s\nceremony    %s\nschema      %s\n", name, doc.Ceremony, doc.Schema)
	fmt.Fprintf(w, "sha256      %x  (canonical bytes; what a signature covers)\n\nCHECKED\n", sum)

	r := &report{w: w}
	// The canonical form is the load-bearing check. Duplicate keys and trailing
	// bytes never get this far -- jcs.Canonical refuses them above -- and a
	// document that equals its own canonical form additionally cannot carry
	// alternate escapes, reordered members or stray whitespace. So a reader who
	// re-serialises it recovers the bytes the signature was made over, and
	// cannot be shown one value while a parser sees another.
	r.check("canonical form, RFC 8785", canonicalErr(raw, canonical))
	r.check("schema", expect(doc.Schema, schema))

	c, err := parse(doc.Entries)
	r.check(fmt.Sprintf("entry chain, %d entries", len(doc.Entries)), err)
	if err != nil {
		fmt.Fprintf(w, "\nFAILED  %d check(s); the chain is unreadable, so nothing below it ran.\n", r.failed)
		return errors.New("checks failed")
	}
	r.check("shape: opens with open, ends with close", c.checkShape())
	r.check("entropy sources", c.checkEntropy())
	r.check("share sets: thresholds only, no holder recorded", c.checkShards())
	r.check("paths: SPEC.md section 3, nothing under a reserved branch", c.checkPaths())
	r.check("leaf material matches its key type", c.checkLeaves())
	r.check("certificates: fingerprint, key binding, chain", c.checkCerts())

	fmt.Fprintln(w, "\nASSERTED, NOT VERIFIED  (nothing below is checkable from the transcript)")
	for _, line := range [][2]string{
		{"outcome", c.closing.Outcome},
		{"pinned time", c.open.PinnedTime},
		{"hardware", c.open.Hardware},
		{"witnesses", fmt.Sprint(c.open.Witnesses)},
		{"entropy mix", c.mix},
		{"spec sha256", c.open.SpecSHA256},
		{"binary sha256", c.open.BinarySHA256},
		{"image sha256", c.open.ImageSHA256},
		{"built from", c.open.VCSRef + " on " + c.open.Platform + " with " + c.open.Toolchain},
		{"build command", c.open.Build},
		{"image", c.open.ImageRef},
	} {
		fmt.Fprintf(w, "  %-16s  %s\n", line[0], line[1])
	}
	for _, a := range c.closing.Attestations {
		fmt.Fprintf(w, "  %-16s  %s\n", "attestation", a)
	}
	fmt.Fprintf(w, "  %-16s  %s\n", "notes", c.open.Notes)
	fmt.Fprintf(w, "\nSIGNATURE  not checked here. Run:\n"+
		"  ssh-keygen -Y verify -f %s -I %s -n %s -s %s.sig < %s\n",
		c.open.AllowedSigners, c.open.SignerIdentity, c.open.SignatureNamespace, name, name)

	if r.failed > 0 {
		fmt.Fprintf(w, "\nFAILED  %d check(s).\n", r.failed)
		return errors.New("checks failed")
	}
	fmt.Fprint(w, "\nOK  every check this tool can make passed. It cannot tell you which\n"+
		"binary produced this transcript; nothing can. See TRANSCRIPT.md.\n")
	return nil
}

// report accumulates pass/fail lines. A failed check never stops the run: an
// operator holding a broken transcript wants every finding at once, not the
// first one.
type report struct {
	w      io.Writer
	failed int
}

func (r *report) check(name string, err error) {
	if err != nil {
		r.failed++
		fmt.Fprintf(r.w, "  FAIL  %s: %v\n", name, err)
		return
	}
	fmt.Fprintf(r.w, "  ok    %s\n", name)
}

func expect(got, want string) error {
	if got != want {
		return fmt.Errorf("%q, want %q", got, want)
	}
	return nil
}

func canonicalErr(raw, canonical []byte) error {
	if bytes.Equal(raw, canonical) {
		return nil
	}
	if bytes.Equal(bytes.TrimRight(raw, "\n\r \t"), canonical) {
		return errors.New("trailing whitespace: the file is signed as-is and carries no final newline")
	}
	return errors.New("the published file must be the canonical bytes exactly")
}

// parse replays the hash chain and decodes every body. Each entry's bytes
// inside the canonical document hash to the next entry's prev, so a reordered,
// inserted, removed or edited entry breaks the link -- and a truncated ceremony
// ends up short rather than looking whole.
func parse(raws []json.RawMessage) (*ceremony, error) {
	if len(raws) == 0 {
		return nil, errors.New("no entries")
	}
	c := &ceremony{leaves: map[string]leafBody{}}
	prev := genesis
	for i, raw := range raws {
		var e entry
		if err := strict(raw, &e); err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		if e.Seq != i {
			return nil, fmt.Errorf("entry %d declares seq %d", i, e.Seq)
		}
		if e.Prev != prev {
			return nil, fmt.Errorf("entry %d links to %s, but entry %d hashes to %s", i, e.Prev, i-1, prev)
		}
		if err := c.add(e); err != nil {
			return nil, fmt.Errorf("entry %d (%s): %w", i, e.Step, err)
		}
		sum := sha256.Sum256(raw)
		prev = hex.EncodeToString(sum[:])
	}
	return c, nil
}

// add refuses an unknown step, so an entry this tool cannot account for is a
// failure rather than something it skips past.
func (c *ceremony) add(e entry) error {
	c.steps = append(c.steps, e.Step)
	switch e.Step {
	case "open":
		return strict(e.Body, &c.open)
	case "close":
		return strict(e.Body, &c.closing)
	case "entropy":
		var b entropyBody
		if err := strict(e.Body, &b); err != nil {
			return err
		}
		c.mix, c.sources = b.Mix, append(c.sources, b.Sources...)
		return nil
	case "shards":
		var b shardsBody
		if err := strict(e.Body, &b); err != nil {
			return err
		}
		c.shards = append(c.shards, b)
		return nil
	case "leaf":
		var b leafBody
		if err := strict(e.Body, &b); err != nil {
			return err
		}
		if _, dup := c.leaves[b.Path]; dup {
			return fmt.Errorf("a second leaf entry for %s", b.Path)
		}
		c.leaves[b.Path] = b
		return nil
	case "certificate":
		var b certBody
		if err := strict(e.Body, &b); err != nil {
			return err
		}
		c.certs = append(c.certs, b)
		return nil
	case "reserved":
		var b reservedBody
		if err := strict(e.Body, &b); err != nil {
			return err
		}
		c.reserved = append(c.reserved, b.Names...)
		return nil
	}
	return fmt.Errorf("unknown step %q", e.Step)
}

func (c *ceremony) count(step string) int {
	n := 0
	for _, s := range c.steps {
		if s == step {
			n++
		}
	}
	return n
}

func (c *ceremony) checkShape() error {
	if c.count("open") != 1 || c.steps[0] != "open" {
		return fmt.Errorf("%d open entries, and entry 0 is %q", c.count("open"), c.steps[0])
	}
	last := c.steps[len(c.steps)-1]
	if c.count("close") != 1 || last != "close" {
		return fmt.Errorf("%d close entries and the last entry is %q: an unterminated chain is an abandoned ceremony", c.count("close"), last)
	}
	if o := c.closing.Outcome; o != "complete" && o != "aborted" {
		return fmt.Errorf("outcome %q, want complete or aborted", o)
	}
	if _, err := time.Parse(time.RFC3339, c.open.PinnedTime); err != nil {
		return fmt.Errorf("pinned_time %q: %w", c.open.PinnedTime, err)
	}
	return nil
}

func (c *ceremony) checkEntropy() error {
	seen := map[string]bool{}
	for _, s := range c.sources {
		if s.Label == "" || seen[s.Label] {
			return fmt.Errorf("source %q is unnamed or repeated", s.Label)
		}
		seen[s.Label] = true
		if s.Bytes <= 0 {
			return fmt.Errorf("source %q contributed %d bytes", s.Label, s.Bytes)
		}
		// A digest of a contribution below the floor is a brute-force target
		// rather than a witness: publishing it would hand an attacker the
		// search the source failed to make expensive.
		if s.WitnessSHA256 != "" && s.MinEntropyBits < witnessFloorBits {
			return fmt.Errorf("source %q publishes a digest at %d bits, below the %d-bit floor",
				s.Label, s.MinEntropyBits, witnessFloorBits)
		}
		if s.WitnessSHA256 != "" && !isHex(s.WitnessSHA256, sha256.Size) {
			return fmt.Errorf("source %q witness digest is not 32 hex-encoded bytes", s.Label)
		}
		if s.Tally != nil {
			sum := 0
			for _, n := range s.Tally {
				sum += n
			}
			if len(s.Tally) != 6 || sum != s.Bytes {
				return fmt.Errorf("source %q tally covers %d of %d rolls", s.Label, sum, s.Bytes)
			}
		}
	}
	// One source cannot degrade: the mixing construction's whole claim is that
	// a compromised contributor is survivable, which needs someone to survive.
	if len(c.sources) < 2 {
		return fmt.Errorf("%d entropy sources, want at least 2", len(c.sources))
	}
	return nil
}

func (c *ceremony) checkShards() error {
	seen := map[string]bool{}
	for _, s := range c.shards {
		if seen[s.Secret] {
			return fmt.Errorf("two share sets for %q", s.Secret)
		}
		seen[s.Secret] = true
		if s.Secret != "master" {
			if err := checkBranchPath(s.Secret); err != nil {
				return err
			}
		}
		if err := expect(s.Encoding, "slip39"); err != nil {
			return fmt.Errorf("%s: encoding %w", s.Secret, err)
		}
		// A threshold of 1 is not a quorum, and a threshold equal to the share
		// count means losing any single share loses the secret.
		if s.Threshold < 2 || s.Threshold >= s.Shares || s.Shares > 16 {
			return fmt.Errorf("%s: %d-of-%d is not a survivable quorum", s.Secret, s.Threshold, s.Shares)
		}
		// SLIP-39 rationale 10: newly created share sets must be extendable.
		if !s.Extendable {
			return fmt.Errorf("%s: share set is not extendable", s.Secret)
		}
		if s.IterationExponent < 0 || s.Identifier < 0 || s.Identifier > 0x7fff {
			return fmt.Errorf("%s: identifier %d or exponent %d is outside SLIP-39's range",
				s.Secret, s.Identifier, s.IterationExponent)
		}
		if !isHex(s.CheckSHA256, sha256.Size) {
			return fmt.Errorf("%s: check digest is not 32 hex-encoded bytes", s.Secret)
		}
	}
	if !seen["master"] {
		return errors.New("no master share set")
	}
	return nil
}

func (c *ceremony) checkPaths() error {
	// Every branch that actually has a share set. A leaf under anything else is
	// material that dies with the master, which is the precise failure the
	// two-tier quorum exists to prevent -- and the reserved-name list below only
	// covers the two branches someone thought of in advance.
	sharded := make(map[string]bool, len(c.shards))
	for _, s := range c.shards {
		sharded[s.Secret] = true
	}
	for path := range c.leaves {
		if err := checkLeafPath(path); err != nil {
			return err
		}
		parts, err := splitPath(path)
		if err != nil {
			return err
		}
		if branch := strings.Join(parts[:3], "/"); !sharded[branch] {
			return fmt.Errorf("leaf %q descends from branch %q, which has no share set: material derived there dies with the master", path, branch)
		}
	}
	for _, n := range c.reserved {
		if !contains(reservedBranches, n) {
			return fmt.Errorf("%q is reserved here but is not a reserved branch name", n)
		}
	}
	return nil
}

func (c *ceremony) checkLeaves() error {
	if len(c.leaves) == 0 {
		return errors.New("no leaf keys")
	}
	for path, l := range c.leaves {
		switch l.KeyType {
		case "ed25519":
			if !isHex(l.Public, ed25519.PublicKeySize) || l.Recipient != "" || l.Words != 0 {
				return fmt.Errorf("%s: an ed25519 leaf carries a 32-byte hex public key and nothing else", path)
			}
		case "x25519-age":
			// Not bech32-decoded: that is forty lines of checksum arithmetic in
			// the artifact whose value is being small, to catch a typo in a
			// string no human ever types. Prefix and length catch a truncation.
			// ponytail: decode properly if a recipient is ever hand-entered.
			if !strings.HasPrefix(l.Recipient, "age1") || len(l.Recipient) != 62 || l.Public != "" || l.Words != 0 {
				return fmt.Errorf("%s: an age leaf carries an age1 recipient and nothing else", path)
			}
		case "bip39":
			// A mnemonic has no public half, and nothing derived from it is
			// published: a digest would only let the holder of a candidate
			// wallet confirm it belongs to this estate.
			if l.Words != 24 || l.Public != "" || l.Recipient != "" {
				return fmt.Errorf("%s: a bip39 leaf records 24 words and no key material", path)
			}
		default:
			return fmt.Errorf("%s: unknown key type %q", path, l.KeyType)
		}
	}
	return nil
}

// checkCerts is the one place a stranger gets cryptographic evidence rather
// than an assertion: the certificates travel inside the transcript, so their
// signatures verify here, and each one's public key must be a key the
// transcript already declared as derived.
func (c *ceremony) checkCerts() error {
	if len(c.certs) == 0 {
		return nil
	}
	notBefore, err := time.Parse(time.RFC3339, c.open.PinnedTime)
	if err != nil {
		return fmt.Errorf("pinned_time %q: %w", c.open.PinnedTime, err)
	}
	byRole := map[string]*x509.Certificate{}
	for _, b := range c.certs {
		der, err := base64.StdEncoding.DecodeString(b.DER)
		if err != nil {
			return fmt.Errorf("%s: %w", b.Role, err)
		}
		if sum := sha256.Sum256(der); hex.EncodeToString(sum[:]) != b.SHA256 {
			return fmt.Errorf("%s: declared fingerprint %s, but the certificate hashes to %x", b.Role, b.SHA256, sum)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return fmt.Errorf("%s: %w", b.Role, err)
		}
		if !cert.IsCA {
			return fmt.Errorf("%s: not a CA certificate", b.Role)
		}
		// notBefore comes from the pinned instant, not the clock, which is what
		// makes minting reproducible. A drifting value means it did not.
		if !cert.NotBefore.Equal(notBefore) {
			return fmt.Errorf("%s: notBefore %s, but the ceremony pinned %s",
				b.Role, cert.NotBefore.UTC().Format(time.RFC3339), c.open.PinnedTime)
		}
		leaf, ok := c.leaves[b.KeyPath]
		if !ok {
			return fmt.Errorf("%s: certifies %q, which no leaf entry declares", b.Role, b.KeyPath)
		}
		pub, ok := cert.PublicKey.(ed25519.PublicKey)
		if !ok {
			return fmt.Errorf("%s: %T public key, want ed25519", b.Role, cert.PublicKey)
		}
		if hex.EncodeToString(pub) != leaf.Public {
			return fmt.Errorf("%s: certificate key %x is not the declared key %s", b.Role, pub, leaf.Public)
		}
		if _, dup := byRole[b.Role]; dup {
			return fmt.Errorf("two %q certificates", b.Role)
		}
		byRole[b.Role] = cert
	}
	root, ok := byRole["root"]
	if !ok {
		return errors.New("no root certificate to anchor the chain")
	}
	if err := root.CheckSignatureFrom(root); err != nil {
		return fmt.Errorf("root is not self-signed: %w", err)
	}
	if inter, ok := byRole["intermediate"]; ok {
		if err := inter.CheckSignatureFrom(root); err != nil {
			return fmt.Errorf("intermediate is not signed by the root: %w", err)
		}
	}
	return nil
}

// Path syntax, SPEC.md section 3.1. Reimplemented here rather than imported: a
// verifier sharing its path parser with the thing it verifies cannot catch a
// bug in that parser.

func splitPath(path string) ([]string, error) {
	if len(path) == 0 || len(path) > 128 {
		return nil, fmt.Errorf("path %q is empty or over 128 octets", path)
	}
	parts := strings.Split(path, "/")
	if len(parts) > 16 {
		return nil, fmt.Errorf("path %q has %d components", path, len(parts))
	}
	for _, c := range parts {
		if err := checkComponent(c); err != nil {
			return nil, fmt.Errorf("path %q: %w", path, err)
		}
	}
	if parts[0] != "fml" {
		return nil, fmt.Errorf("path %q does not start at fml", path)
	}
	if !isVersion(parts[len(parts)-1]) {
		return nil, fmt.Errorf("path %q does not end in a version component", path)
	}
	return parts, nil
}

func checkComponent(c string) error {
	if c == "" {
		return errors.New("empty component")
	}
	if c[0] < 'a' || c[0] > 'z' {
		return fmt.Errorf("component %q does not start with a lowercase letter", c)
	}
	for i := 1; i < len(c); i++ {
		if b := c[i]; (b < 'a' || b > 'z') && (b < '0' || b > '9') && b != '-' {
			return fmt.Errorf("component %q contains %q", c, b)
		}
	}
	return nil
}

func isVersion(c string) bool {
	if len(c) < 2 || c[0] != 'v' || c[1] < '1' || c[1] > '9' {
		return false
	}
	for i := 2; i < len(c); i++ {
		if c[i] < '0' || c[i] > '9' {
			return false
		}
	}
	return true
}

func checkBranchPath(path string) error {
	parts, err := splitPath(path)
	if err != nil {
		return err
	}
	if len(parts) != 3 {
		return fmt.Errorf("branch %q has %d components, want 3", path, len(parts))
	}
	return nil
}

func checkLeafPath(path string) error {
	parts, err := splitPath(path)
	if err != nil {
		return err
	}
	if len(parts) < 5 {
		return fmt.Errorf("leaf %q has %d components, want at least 5", path, len(parts))
	}
	if branch := strings.Join(parts[:2], "/"); contains(reservedBranches, branch) {
		return fmt.Errorf("leaf %q is under reserved branch %q, which mints nothing and has no share set", path, branch)
	}
	return nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func isHex(s string, n int) bool {
	if len(s) != n*2 || strings.ToLower(s) != s {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
