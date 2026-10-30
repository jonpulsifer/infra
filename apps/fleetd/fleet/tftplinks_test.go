package fleet

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

const testTarget = "/var/lib/tftpboot/talos/folly/ipxe.efi"

func linkOf(dir, mac string) string {
	got, err := os.Readlink(filepath.Join(dir, mac, NetbootLink))
	if err != nil {
		return ""
	}
	return got
}

func TestSyncLinksEachMAC(t *testing.T) {
	dir := t.TempDir()
	l := &TFTPLinks{Dir: dir, Target: testTarget}
	if err := l.Sync([]string{"38:22:e2:2d:96:44", "EC:8E:B5:72:35:24"}); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"38:22:e2:2d:96:44", "ec:8e:b5:72:35:24"} {
		if got := linkOf(dir, m); got != testTarget {
			t.Errorf("%s links to %q", m, got)
		}
	}
}

func TestSyncRemovesStaleLinksAndKeepsOtherFiles(t *testing.T) {
	dir := t.TempDir()
	l := &TFTPLinks{Dir: dir, Target: testTarget}
	if err := l.Sync([]string{"38:22:e2:2d:96:44", "ec:8e:b5:72:35:24"}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "talos", "folly"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "talos", "folly", "ipxe.efi"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(dir, "14:b3:1f:2b:57:85")
	if err := os.MkdirAll(custom, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(custom, "other"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(testTarget, filepath.Join(custom, NetbootLink)); err != nil {
		t.Fatal(err)
	}

	if err := l.Sync([]string{"38:22:e2:2d:96:44"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "ec:8e:b5:72:35:24")); !os.IsNotExist(err) {
		t.Errorf("the stale directory remains: %v", err)
	}
	if linkOf(dir, "38:22:e2:2d:96:44") != testTarget {
		t.Error("a wanted link went")
	}
	if _, err := os.Stat(filepath.Join(dir, "talos", "folly", "ipxe.efi")); err != nil {
		t.Errorf("an unrelated file went: %v", err)
	}
	if _, err := os.Stat(filepath.Join(custom, "other")); err != nil {
		t.Errorf("a file in a stale MAC directory went: %v", err)
	}
}

func TestSyncRepointsAWrongLink(t *testing.T) {
	dir := t.TempDir()
	mac := "38:22:e2:2d:96:44"
	if err := os.MkdirAll(filepath.Join(dir, mac), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/elsewhere", filepath.Join(dir, mac, NetbootLink)); err != nil {
		t.Fatal(err)
	}
	if err := (&TFTPLinks{Dir: dir, Target: testTarget}).Sync([]string{mac}); err != nil {
		t.Fatal(err)
	}
	if got := linkOf(dir, mac); got != testTarget {
		t.Errorf("links to %q", got)
	}
}

func TestSyncRefusesNamesThatAreNotMACs(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tftp")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bad := []string{"../escape", "../../etc", "38:22:e2:2d:96:44/../x", "38-22-e2-2d-96-44", "", "zz:22:e2:2d:96:44"}
	if err := (&TFTPLinks{Dir: dir, Target: testTarget}).Sync(bad); err == nil {
		t.Error("no error for names that are not MACs")
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Errorf("something was written outside the directory: %v", entries)
	}
	if inner, _ := os.ReadDir(dir); len(inner) != 0 {
		t.Errorf("a bad name made %v", inner)
	}
}

func TestReconcileKeepsLinksForNetBoxMACs(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("swell", "planned", "none", nil)}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	dir := t.TempDir()
	r.Links = &TFTPLinks{Dir: dir, Target: testTarget}
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := linkOf(dir, "38:22:e2:2d:96:44"); got != testTarget {
		t.Errorf("riptide links to %q", got)
	}
}
