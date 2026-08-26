package derive

import (
	"crypto/ed25519"
	"fmt"
	"strings"
)

// KeyType names the mapping from leaf OKM to key material (SPEC.md section 7).
type KeyType string

const (
	KeyEd25519 KeyType = "ed25519"
	KeyAge     KeyType = "x25519-age"
	KeyBIP39   KeyType = "bip39"
)

// LeafDecl is one row of SPEC.md's section 6.2 table. L is part of the
// declaration rather than a call-site argument because RFC 5869 does not bind
// the requested length into the expansion input: the same path at two lengths
// would be prefix-related instead of independent.
type LeafDecl struct {
	Path   string
	Branch string
	Type   KeyType
	L      int
}

// MintedBranches and ReservedBranches are SPEC.md section 6.1.
//
// A reserved name mints nothing: no secret is derived under it and no share set
// exists, so material derived there would die with the master — precisely the
// failure the two-tier quorum exists to prevent. The names are spoken for so a
// future branch cannot be given one that already means something to somebody.
var (
	MintedBranches   = []string{"fml/infra/v1", "fml/wallet/v1"}
	ReservedBranches = []string{"fml/kms", "fml/ssh"}
)

// V1Tree is the whole of v1: four leaves, three key types, two branches.
var V1Tree = []LeafDecl{
	{Path: "fml/infra/v1/pki/root/v1", Branch: "fml/infra/v1", Type: KeyEd25519, L: 32},
	{Path: "fml/infra/v1/pki/intermediate/v1", Branch: "fml/infra/v1", Type: KeyEd25519, L: 32},
	{Path: "fml/infra/v1/age/operator/v1", Branch: "fml/infra/v1", Type: KeyAge, L: 32},
	{Path: "fml/wallet/v1/cold/v1", Branch: "fml/wallet/v1", Type: KeyBIP39, L: 32},
}

// Declared looks a leaf path up in the v1 tree. The ceremony mints only what is
// declared: a version higher than any in SPEC.md is simply an undeclared path
// and stays rejected until a revision of that document declares it. There is no
// implicit "latest".
//
// A verifier is under no such restriction — refusing to check arithmetic is not
// a security property — which is why Branch and Leaf take any well-formed path
// and only this function enforces the tree.
func Declared(leafPath string) (LeafDecl, error) {
	for _, r := range ReservedBranches {
		if leafPath == r || strings.HasPrefix(leafPath, r+"/") {
			return LeafDecl{}, fmt.Errorf("derive: %q is under reserved branch %q, which mints nothing", leafPath, r)
		}
	}
	for _, d := range V1Tree {
		if d.Path == leafPath {
			return d, nil
		}
	}
	return LeafDecl{}, fmt.Errorf("derive: %q is not declared in the v1 tree", leafPath)
}

// Material is one minted leaf. Exactly one of the key fields is set, chosen by
// Leaf.Type; OKM is always the raw expansion output the mapping consumed.
type Material struct {
	Leaf      LeafDecl
	OKM       []byte
	Ed25519   ed25519.PrivateKey // KeyEd25519
	Identity  string             // KeyAge
	Recipient string             // KeyAge
	Mnemonic  string             // KeyBIP39
}

// MintLeaf derives a declared leaf from its branch secret. This is the call a
// branch-share holder makes with 2-of-3 and no master present, which is the
// whole point of chaining the derivation.
//
// branchPath is the caller's claim about which branch the secret came from, and
// it is checked against the declaration rather than read out of it. Taking the
// branch path from the table instead would make this function unable to fail:
// the holder of the fml/wallet/v1 secret asking for an fml/infra leaf would get
// a perfectly well-formed key that nobody else can reproduce, which is exactly
// the silent failure SPEC.md section 3.4 exists to prevent. A 32-octet branch
// secret carries no evidence of which branch it is, so the operator's statement
// of which plates they are holding is the only evidence there is.
func MintLeaf(branchSecret []byte, branchPath, leafPath string) (Material, error) {
	decl, err := Declared(leafPath)
	if err != nil {
		return Material{}, err
	}
	if decl.Branch != branchPath {
		return Material{}, fmt.Errorf("derive: leaf %q belongs to branch %q, not %q", leafPath, decl.Branch, branchPath)
	}
	okm, err := Leaf(branchSecret, decl.Branch, decl.Path, decl.L)
	if err != nil {
		return Material{}, err
	}
	m := Material{Leaf: decl, OKM: okm}
	switch decl.Type {
	case KeyEd25519:
		m.Ed25519, err = Ed25519FromOKM(okm)
	case KeyAge:
		m.Identity, m.Recipient, err = AgeFromOKM(okm)
	case KeyBIP39:
		m.Mnemonic, err = MnemonicFromEntropy(okm)
	default:
		err = fmt.Errorf("derive: leaf %q has unknown key type %q", decl.Path, decl.Type)
	}
	if err != nil {
		return Material{}, err
	}
	return m, nil
}

// MintFromMaster is MintLeaf with the level-1 derivation in front, for the one
// moment in the ceremony where the master seed is in memory.
func MintFromMaster(masterSeed []byte, leafPath string) (Material, error) {
	decl, err := Declared(leafPath)
	if err != nil {
		return Material{}, err
	}
	secret, err := Branch(masterSeed, decl.Branch)
	if err != nil {
		return Material{}, err
	}
	return MintLeaf(secret, decl.Branch, leafPath)
}
