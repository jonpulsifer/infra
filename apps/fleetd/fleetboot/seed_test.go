package fleetboot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A cloud-init image gets its NoCloud seed now, on the Linux root, fetched
// from fleetd with the UUID and the code.
func TestRunSeedsACloudInitImage(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.addPart("nvme0n1", 1, 2048, 2048)
	m.addPart("nvme0n1", 2, 4096, 4063)
	img := makeGPT(t, 8192, []testPart{
		{TypeESP, espGUID, 2048, 4095, "ESP"},
		{TypeLinuxRoot, rootGUID, 4096, 8158, "root"},
	})
	sum := sha256.Sum256(img)
	seed := tarOf(t, map[string]string{"user-data": "#cloud-config\n", "meta-data": "instance-id: x\n"})
	var query string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/seed" {
			query = r.URL.RawQuery
			w.Write(seed)
			return
		}
		w.Write(img)
	}))
	defer srv.Close()
	run := imageRun()
	run.Disk, run.ImageURL, run.ImageFormat = m.disk, srv.URL+"/debian.img", "raw"
	run.ImageDigest = "sha256:" + hex.EncodeToString(sum[:])
	run.PayloadKind, run.OS, run.SeedURL = "cloud-init-nocloud", "debian", srv.URL+"/seed"
	e := m.executor(&reports{})
	e.HTTP = srv.Client()
	if err := e.Run(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if query != "code="+e.Code+"&uuid="+e.UUID {
		t.Errorf("seed query %q", query)
	}
	if b, err := os.ReadFile(filepath.Join(m.ram, "root", NoCloudDir, "meta-data")); err != nil || string(b) != "instance-id: x\n" {
		t.Errorf("meta-data %q %v", b, err)
	}
	if len(m.efiVars.entries) != 1 || m.efiVars.entries[0].Label != "fleet debian" {
		t.Errorf("entries %+v", m.efiVars.entries)
	}
}

// A seed fleetd refuses leaves the image written without one, and the run
// fails.
func TestRunFailsWithoutASeed(t *testing.T) {
	m := newMachine(t, 16<<20)
	m.addPart("nvme0n1", 1, 2048, 2048)
	img := makeGPT(t, 8192, []testPart{{TypeESP, espGUID, 2048, 4095, "ESP"}})
	sum := sha256.Sum256(img)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/seed" {
			http.Error(w, "gone", http.StatusGone)
			return
		}
		w.Write(img)
	}))
	defer srv.Close()
	run := imageRun()
	run.Disk, run.ImageURL, run.ImageFormat = m.disk, srv.URL+"/debian.img", "raw"
	run.ImageDigest = "sha256:" + hex.EncodeToString(sum[:])
	run.PayloadKind, run.SeedURL = "cloud-init-nocloud", srv.URL+"/seed"
	rep := &reports{}
	e := m.executor(rep)
	e.HTTP = srv.Client()
	if err := e.Run(context.Background(), run); err == nil {
		t.Fatal("the run passed without a seed")
	}
	if got := rep.phases(); got[len(got)-1] != "install failed" {
		t.Errorf("reports %v", got)
	}
}
