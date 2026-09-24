package derive

import (
	"crypto/ed25519"
	"fmt"
	"strings"
)

// KeyType names the mapping from leaf OKM to key material.
type KeyType string

const (
	KeyEd25519 KeyType = "ed25519"
	KeyAge     KeyType = "x25519-age"
	KeyBIP39   KeyType = "bip39"
)

// LeafDecl is one row of SPEC.md's leaf table. L is declared here because RFC
// 5869 does not bind it, so one path at two lengths gives prefix-related output.
type LeafDecl struct {
	Path   string
	Branch string
	Type   KeyType
	L      int
}

// A reserved branch mints nothing and has no share set. The names are held so
// a future branch cannot reuse one.
var (
	MintedBranches   = []string{"fml/infra/v1", "fml/wallet/v1"}
	ReservedBranches = []string{"fml/kms", "fml/ssh"}
)

// V1Tree declares every v1 leaf.
var V1Tree = []LeafDecl{
	{Path: "fml/infra/v1/pki/root/v1", Branch: "fml/infra/v1", Type: KeyEd25519, L: 32},
	{Path: "fml/infra/v1/pki/intermediate/v1", Branch: "fml/infra/v1", Type: KeyEd25519, L: 32},
	{Path: "fml/infra/v1/age/operator/v1", Branch: "fml/infra/v1", Type: KeyAge, L: 32},
	{Path: "fml/wallet/v1/cold/v1", Branch: "fml/wallet/v1", Type: KeyBIP39, L: 32},
}

// Declared looks a leaf up in the v1 tree, with no implicit "latest". Only this
// enforces the tree, because a verifier may derive any well-formed path.
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

// Material is one minted leaf. One key field is set, chosen by Leaf.Type.
type Material struct {
	Leaf      LeafDecl
	OKM       []byte
	Ed25519   ed25519.PrivateKey // KeyEd25519
	Identity  string             // KeyAge
	Recipient string             // KeyAge
	Mnemonic  string             // KeyBIP39
}

// MintLeaf derives a declared leaf from its branch secret, without the master. A
// secret does not identify its branch, so branchPath is checked, never inferred.
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

// MintFromMaster is MintLeaf with the master-to-branch derivation in front.
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
