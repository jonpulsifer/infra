package client

import (
	"bytes"
	"testing"

	tools "github.com/google/go-tpm-tools/client"
	"github.com/google/go-tpm/legacy/tpm2"
)

func encode(t *testing.T, p tpm2.Public) []byte {
	t.Helper()
	b, err := p.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The EK templates are the TCG's, and the SRK is the one SPIRE's tpm_devid
// agent builds (pkg/agent/plugin/nodeattestor/tpmdevid/tpmutil
// SRKTemplateHighECC at v1.15.5: go-tpm-tools' ECC SRK with an empty unique),
// so the LDevID blobs load there.
func TestTemplatesMatchTheirReferences(t *testing.T) {
	spireSRK := tools.SRKTemplateECC()
	spireSRK.ECCParameters.Point.XRaw = []byte{}
	spireSRK.ECCParameters.Point.YRaw = []byte{}
	for name, c := range map[string]struct{ got, want tpm2.Public }{
		"RSA EK": {EKTemplateRSA, tools.DefaultEKTemplateRSA()},
		"ECC EK": {EKTemplateECC, tools.DefaultEKTemplateECC()},
		"SRK":    {SRKTemplate, spireSRK},
	} {
		if !bytes.Equal(encode(t, c.got), encode(t, c.want)) {
			t.Errorf("%s template differs from its reference", name)
		}
	}
}

func TestTrimDER(t *testing.T) {
	long := append([]byte{0x30, 0x82, 0x01, 0x07}, make([]byte, 0x107+5)...)
	for _, c := range []struct {
		in   []byte
		want int
	}{
		{[]byte{0x30, 0x03, 1, 2, 3, 0xff}, 5},
		{append([]byte{0x30, 0x81, 0x80}, make([]byte, 0x80+2)...), 0x83},
		{long, 0x10b},
	} {
		if got := trimDER(c.in); len(got) != c.want {
			t.Errorf("trimDER(%x...) kept %d bytes, want %d", c.in[:4], len(got), c.want)
		}
	}
}
