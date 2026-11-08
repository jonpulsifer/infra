package fleetboot

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestInventoryNamesEachDevicesSerial(t *testing.T) {
	sys := t.TempDir()
	write := func(path, body string) {
		t.Helper()
		p := filepath.Join(sys, path)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("block/nvme0n1/device/serial", "  30LPD1AZPTLL  \n")
	write("block/nvme0n1/device/model", "KXG60ZNV512G TOSHIBA\n")
	write("block/nvme0n1/size", "1000215216\n")
	write("block/nvme0n1/removable", "0\n")
	write("block/loop0/size", "0\n")

	got := Inventory(sys)
	want := []string{`nvme0n1 model="KXG60ZNV512G TOSHIBA" serial="30LPD1AZPTLL" size=512GB removable=0 usb=false`}
	if !slices.Equal(got, want) {
		t.Fatalf("Inventory = %q, want %q", got, want)
	}
}
