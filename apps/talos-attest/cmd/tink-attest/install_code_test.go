package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteInstallCode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fleet")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "install_code")
	for _, code := range []string{"first-code", "second-code"} {
		if err := writeInstallCode(path, code); err != nil {
			t.Fatal(err)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != code {
			t.Fatalf("install code %q, %v; want %q", b, err, code)
		}
	}
	for p, want := range map[string]fs.FileMode{dir: 0o700, path: 0o600} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != want {
			t.Fatalf("%s: mode %v, %v; want %v", p, st.Mode().Perm(), err, want)
		}
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("the directory holds %d entries, want the code alone", len(entries))
	}

	if err := removeInstallCode(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a stale code survived: %v", err)
	}
	if err := removeInstallCode(path); err != nil {
		t.Fatalf("removing no code: %v", err)
	}
}
