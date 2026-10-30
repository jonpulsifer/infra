package fleet

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// NetbootLink is the file name Smee offers a MAC while allowPXE is off.
const NetbootLink = "netboot-not-allowed"

var macName = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

// TFTPLinks keeps <Dir>/<mac>/netboot-not-allowed pointing at Target for
// each MAC NetBox holds. Firmware that takes Smee's offer over the
// network's DHCP fetches that path, and Target is the signed iPXE.
type TFTPLinks struct {
	Dir    string
	Target string
}

// Sync makes the links match macs. It creates the missing ones, repoints
// the wrong ones and removes the links of MACs not in macs. Only a
// directory named for a MAC that holds nothing but the link is removed, so
// the TFTP root's other files stay.
func (t *TFTPLinks) Sync(macs []string) error {
	want := map[string]bool{}
	var errs []error
	for _, m := range macs {
		m = strings.ToLower(m)
		if !macName.MatchString(m) {
			errs = append(errs, fmt.Errorf("tftp link: %q is not a MAC", m))
			continue
		}
		want[m] = true
		if err := t.ensure(m); err != nil {
			errs = append(errs, fmt.Errorf("tftp link %s: %w", m, err))
		}
	}
	entries, err := os.ReadDir(t.Dir)
	if err != nil {
		return errors.Join(append(errs, err)...)
	}
	for _, e := range entries {
		if !e.IsDir() || !macName.MatchString(e.Name()) || want[e.Name()] {
			continue
		}
		dir := filepath.Join(t.Dir, e.Name())
		link := filepath.Join(dir, NetbootLink)
		if fi, err := os.Lstat(link); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(link); err != nil {
				errs = append(errs, fmt.Errorf("tftp link %s: %w", e.Name(), err))
				continue
			}
		}
		_ = os.Remove(dir)
	}
	return errors.Join(errs...)
}

func (t *TFTPLinks) ensure(mac string) error {
	dir := filepath.Join(t.Dir, mac)
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return err
	}
	link := filepath.Join(dir, NetbootLink)
	if got, err := os.Readlink(link); err == nil && got == t.Target {
		return nil
	}
	tmp := link + ".tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(t.Target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
