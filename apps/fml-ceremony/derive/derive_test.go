package derive

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// TestRFC5869Case1 pins Go's hkdf.Extract argument order, which is the reverse
// of RFC 5869's prose HKDF-Extract(salt, IKM). Swapping them produces a
// well-formed wrong answer with no error, so every other vector in this file
// would still look self-consistent while disagreeing with every other
// implementation. SPEC.md section 10 requires this check to run first.
func TestRFC5869Case1(t *testing.T) {
	ikm := mustHex(t, strings.Repeat("0b", 22))
	salt := mustHex(t, "000102030405060708090a0b0c")
	info := mustHex(t, "f0f1f2f3f4f5f6f7f8f9")

	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(prk); got != "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5" {
		t.Fatalf("PRK = %s", got)
	}
	okm, err := hkdf.Expand(sha256.New, prk, string(info), 42)
	if err != nil {
		t.Fatal(err)
	}
	want := "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
	if got := hex.EncodeToString(okm); got != want {
		t.Fatalf("OKM = %s, want %s", got, want)
	}
}

// TestAgeSpecExample is the age specification's own published pair. It pins
// Bech32, the uppercase-after-checksum rule and the X25519 basepoint
// multiplication together, so a failure here localises before the tree vectors
// are trusted.
func TestAgeSpecExample(t *testing.T) {
	const (
		identity  = "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX"
		recipient = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj"
	)
	raw, err := AgeIdentityBytes(identity)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(raw); got != strings.Repeat("42", 32) {
		t.Fatalf("identity decodes to %s", got)
	}
	gotID, gotRcpt, err := AgeFromOKM(raw)
	if err != nil {
		t.Fatal(err)
	}
	if gotID != identity {
		t.Errorf("identity round-trip = %s", gotID)
	}
	if gotRcpt != recipient {
		t.Errorf("recipient = %s, want %s", gotRcpt, recipient)
	}
}

func TestBIP39OfficialVectors(t *testing.T) {
	for _, tc := range []struct{ entropy, want string }{
		{strings.Repeat("00", 16), strings.Repeat("abandon ", 11) + "about"},
		{strings.Repeat("ff", 32), strings.Repeat("zoo ", 23) + "vote"},
		{strings.Repeat("7f", 32), "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"},
		{"9e885d952ad362caeb4efe34a8e91bd2", "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic"},
		{"c0ba5a8e914111210f2bd131f3d5e08d", "scheme spot photo card baby mountain device kick cradle pact join borrow"},
	} {
		got, err := MnemonicFromEntropy(mustHex(t, tc.entropy))
		if err != nil {
			t.Fatalf("%s: %v", tc.entropy, err)
		}
		if got != tc.want {
			t.Errorf("entropy %s:\n got %q\nwant %q", tc.entropy, got, tc.want)
		}
	}
}

func TestBIP39WordlistIdentity(t *testing.T) {
	words, err := bip39Words()
	if err != nil {
		t.Fatal(err)
	}
	if len(words) != 2048 {
		t.Fatalf("%d words", len(words))
	}
	if words[0] != "abandon" || words[2047] != "zoo" {
		t.Fatalf("wordlist bounds are %q..%q", words[0], words[2047])
	}
}

// specLeaf is one row of a SPEC.md section 11 vector.
type specLeaf struct {
	path string
	// okm is also the ed25519 seed or the bip39 entropy, per key type.
	okm string
	// pub is the ed25519 public key; identity/recipient the age pair;
	// mnemonic the bip39 words. Exactly one group is populated.
	pub, identity, recipient, mnemonic string
}

type specBranch struct {
	path   string
	secret string
	prk    string
	leaves []specLeaf
}

type specVector struct {
	name     string
	master   string
	prk      string
	branches []specBranch
}

// specVectors is SPEC.md section 11 transcribed verbatim, every published PRK
// included. The PRKs are what localise a disagreement to a level instead of
// leaving two implementations to argue about a public key.
var specVectors = []specVector{
	{
		name:   "A",
		master: "0000000000000000000000000000000000000000000000000000000000000000",
		prk:    "f1257b2cebf618f4c697b1a723f037dfa14cfac1bb89236402297e664040cca8",
		branches: []specBranch{
			{
				path:   "fml/infra/v1",
				secret: "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37",
				prk:    "901e641ec9454662ec61507b972302100676d267e0aea42b9398007fe7998001",
				leaves: []specLeaf{
					{path: "fml/infra/v1/pki/root/v1", okm: "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c", pub: "58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03"},
					{path: "fml/infra/v1/pki/intermediate/v1", okm: "81686d1cb25f96f91efdb5158468278dab9e5c88fb6073e2bccf51da31bf6087", pub: "5f017b89fc0875aa4f481e5a2e04f7afb9b246ae5bab905832f2ae126f9a20fd"},
					{path: "fml/infra/v1/age/operator/v1", okm: "83d4f8384416a6993ec33a14bf8de272c2b9b34ff094ccab2d371c8100a55882",
						identity:  "AGE-SECRET-KEY-1S020SWZYZ6NFJ0KR8G2TLR0ZWTPTNV607Z2VE2EDXUWGZQ99TZPQ7YF972",
						recipient: "age1uzf08nsuz0gwuz9ue0f80re672nfawute7ln8g2ys4vpyg60uu7skcqfru"},
				},
			},
			{
				path:   "fml/wallet/v1",
				secret: "c5c1acdd22bc15d597a801efed2838e5cebcdfd6040fb6f98afc55e5f752c2c7",
				prk:    "bea86c6ff6eb3a2bb79924bd5866994c8f8ae4fa823adc374f24cf0b010d2203",
				leaves: []specLeaf{
					{path: "fml/wallet/v1/cold/v1", okm: "f1c1bd731a859764071fc6b24f3a92f0ef8c6a5da771f2b48aa68774f825e6e1",
						mnemonic: "vault assume fresh crush floor rare broccoli web rather keep pigeon tide web cry isolate until verify picture predict auction exhibit base oppose curious"},
				},
			},
		},
	},
	{
		name:   "B",
		master: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
		prk:    "6ad4324095d92137144e6d005e03a3e85dfec5b448e01994012d968ea8b63763",
		branches: []specBranch{
			{
				path:   "fml/infra/v1",
				secret: "64068319837cf282608f2591bfc2a06ef3ed574549ddb2c05e92cc0e509aa0ac",
				prk:    "2bc82a4f391257d687fe8997a79016cd0f3914e6f382e0db607948c010c56739",
				leaves: []specLeaf{
					{path: "fml/infra/v1/pki/root/v1", okm: "128626be41ea7cc72968ae4ffd408e44af8e359e157ebb7cebd6eab4d2672c78", pub: "e1e0bde2195e3af2b40d5eb7bd33925ecf2d3a60db090c90748fea120b1542cd"},
					{path: "fml/infra/v1/pki/intermediate/v1", okm: "3d763a5a094e39d6bcf2b56f7dbd1e3579b1a6fd825790815e146c638f6b924a", pub: "7cbbbf893f9767b2bbb8a00c150ea2f03d4b378c188bf61a799405294d00f453"},
					{path: "fml/infra/v1/age/operator/v1", okm: "2b2cb7e8e7293387b1dbdeead25ccee5828ee22f088a93010f8455c03d0fa0a8",
						identity:  "AGE-SECRET-KEY-19VKT06889YEC0VWMMM4DYHXWUKPGAC30PZ9FXQG0S32UQ0G05Z5Q5MQXGD",
						recipient: "age13m7cc6eqq0q9782gf50nwz8h3x98a34dmd0z0s6w6n9ma5lqdq7s63dskq"},
				},
			},
			{
				path:   "fml/wallet/v1",
				secret: "a587058479d177408f09e760a881c4e9d601d723bceff34f004ba1e4a853d7c7",
				prk:    "9d10a15bd4454e25e8485eb34a00c4f8a232304d75aab31dc14362ff24cd5e8d",
				leaves: []specLeaf{
					{path: "fml/wallet/v1/cold/v1", okm: "e0f1446937b7d348afe56d366619c673a07443cd1610132dd901d332b1c06745",
						mnemonic: "thought mechanic bottom hunt large picture sauce pumpkin cushion cotton immense trap also capable crowd search basket human document please climb then other rich"},
				},
			},
		},
	},
	{
		name:   "C",
		master: "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218",
		prk:    "12ef3be531acf418a8c669e434829467187a634592b09419261b0bd57805e1b9",
		branches: []specBranch{
			{
				path:   "fml/infra/v1",
				secret: "52b1d2a60af03b5490ea254d7c6a785a0bab666128ed0158f4f751327b059e1f",
				prk:    "a8ab63348be55acea783f1a3b7c2a06534810964e9efd2d7aa44f8b8271d7a7c",
				leaves: []specLeaf{
					{path: "fml/infra/v1/pki/root/v1", okm: "51d6c44753154c34be5f3fb95a6dccfb7112a3070578ee04ce2b6e5d03ea89e1", pub: "4f429415399f473734c0270446f230319fdaae57b7400155b3dee5dad6cd0fc9"},
					{path: "fml/infra/v1/pki/intermediate/v1", okm: "511b5c46f3ed7108d20ef17baec1a4f0a2bdbf3985e4900774141231d5045ee9", pub: "30896637ac0c877c581d6a8eaef286e01ec293442a453d9eeac6c668899747cd"},
					{path: "fml/infra/v1/age/operator/v1", okm: "86d0b56b74fe1c89a76b6144b9a4aa98b851d2164f7afedf832c99fcd1ebc1d9",
						identity:  "AGE-SECRET-KEY-1SMGT26M5LCWGNFMTV9ZTNF92NZU9R5SKFAA0AHUR9JVLE50TC8VSYJVA0W",
						recipient: "age1865h20ytnw8alu2852f9mzjcym7z6eu6pz2n9zjfsq3a9x76937svpvhyx"},
				},
			},
			{
				path:   "fml/wallet/v1",
				secret: "f9cd778a71b3515d96c1b666cc3f1a7c99c1dc57e13ab3a3e12ba263e9178329",
				prk:    "04c8287d8dfd833e2e328b49953627fb774d745c9333dc91baf5b058fbd3defa",
				leaves: []specLeaf{
					{path: "fml/wallet/v1/cold/v1", okm: "d0840ec01b864a053f846e7c8856abc4123687025e6b36aa3acf07b7d94543f2",
						mnemonic: "spatial call quote damage gorilla action wrap miss lady dress priority market casino drum annual sniff cute fade record author laugh pencil average donate"},
				},
			},
		},
	},
}

// TestMasterC confirms vector C's master really is SHA-256 of the 27 ASCII
// octets, so the vector is reproducible from the sentence rather than copied.
func TestMasterC(t *testing.T) {
	sum := sha256.Sum256([]byte("Folly Mountain Laboratories"))
	if got := hex.EncodeToString(sum[:]); got != specVectors[2].master {
		t.Fatalf("sha256(\"Folly Mountain Laboratories\") = %s", got)
	}
}

func TestSpecVectors(t *testing.T) {
	for _, v := range specVectors {
		t.Run(v.name, func(t *testing.T) {
			master := mustHex(t, v.master)
			prk, err := branchPRK(master)
			if err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(prk); got != v.prk {
				t.Fatalf("PRK_master = %s, want %s", got, v.prk)
			}
			for _, b := range v.branches {
				secret, err := Branch(master, b.path)
				if err != nil {
					t.Fatal(err)
				}
				if got := hex.EncodeToString(secret); got != b.secret {
					t.Fatalf("%s branchSecret = %s, want %s", b.path, got, b.secret)
				}
				bp, err := leafPRK(secret)
				if err != nil {
					t.Fatal(err)
				}
				if got := hex.EncodeToString(bp); got != b.prk {
					t.Fatalf("%s PRK_branch = %s, want %s", b.path, got, b.prk)
				}
				for _, l := range b.leaves {
					m, err := MintLeaf(secret, b.path, l.path)
					if err != nil {
						t.Fatal(err)
					}
					if got := hex.EncodeToString(m.OKM); got != l.okm {
						t.Errorf("%s okm = %s, want %s", l.path, got, l.okm)
					}
					switch m.Leaf.Type {
					case KeyEd25519:
						if got := hex.EncodeToString(m.Ed25519.Public().(ed25519.PublicKey)); got != l.pub {
							t.Errorf("%s public = %s, want %s", l.path, got, l.pub)
						}
					case KeyAge:
						if m.Identity != l.identity {
							t.Errorf("%s identity = %s", l.path, m.Identity)
						}
						if m.Recipient != l.recipient {
							t.Errorf("%s recipient = %s", l.path, m.Recipient)
						}
					case KeyBIP39:
						if m.Mnemonic != l.mnemonic {
							t.Errorf("%s mnemonic = %q", l.path, m.Mnemonic)
						}
					}
					// The same leaf must come out of the master-seed entry
					// point too, which is the claim that a branch holder and
					// the master holder derive the same key.
					fromMaster, err := MintFromMaster(master, l.path)
					if err != nil {
						t.Fatal(err)
					}
					if hex.EncodeToString(fromMaster.OKM) != l.okm {
						t.Errorf("%s: master and branch entry points disagree", l.path)
					}
				}
			}
		})
	}
}
