package fleetboot

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// seedFile is what a NixOS or Alpine image's first boot reads from the root
// of its EFI system partition.
type seedFile struct {
	URL  string `json:"url"`
	UUID string `json:"uuid"`
	Code string `json:"code"`
}

// NoCloudDir is where cloud-init's NoCloud source reads a seed on the root
// file system.
const NoCloudDir = "var/lib/cloud/seed/nocloud"

// maxSeed caps a NoCloud seed's tar.
const maxSeed = 8 * mib

// seed writes the run's seed by payload kind. A NixOS or Alpine image gets
// fleet-seed.json on its EFI system partition, and its first boot fetches
// the seed itself. A cloud-init image gets the seed now, on its root, so
// for it the install code is spent here. A Talos image gets the install
// code in META, as the installer's --meta 0x0b=<code> writes it, and its
// first boot fetches its config from talos.config with it.
func (e *Executor) seed(ctx context.Context, r protocol.BootRun, d Disk, g GPT, esp Partition, espDev string) error {
	switch r.PayloadKind {
	case classes.PayloadTalosConfig:
		return e.writeCode(ctx, d, g)
	case classes.PayloadNixOSImage, classes.PayloadAlpineImage:
		return e.withMount(espDev, "vfat", "esp", func(dir string) error {
			b, _ := json.Marshal(seedFile{URL: r.SeedURL, UUID: e.UUID, Code: e.Code})
			if err := os.WriteFile(filepath.Join(dir, "fleet-seed.json"), append(b, '\n'), 0o600); err != nil {
				return fmt.Errorf("fleet-seed.json cannot be written: %w", err)
			}
			e.logf("wrote fleet-seed.json to the EFI system partition")
			return nil
		})
	case classes.PayloadCloudInit:
		seed, err := e.fetchSeed(ctx, r.SeedURL)
		if err != nil {
			return err
		}
		if err := checkSeed(seed); err != nil {
			return fmt.Errorf("%v; the image is written without a seed", err)
		}
		root, err := e.rootPartition(d, g)
		if err != nil {
			return err
		}
		return e.withMount(root, "ext4", "root", func(dir string) error {
			dest := filepath.Join(dir, NoCloudDir)
			if err := extractSeed(seed, dest); err != nil {
				return fmt.Errorf("the seed cannot be extracted to %s: %w", root, err)
			}
			e.logf("wrote the cloud-init seed to %s", root)
			return nil
		})
	}
	return fmt.Errorf("the payload kind %q has no seed", r.PayloadKind)
}

// writeCode writes the install code into the Talos image's META partition
// through the disk, then drops the disk's buffers and reads it back from a
// new descriptor, so the check reads what the device holds.
func (e *Executor) writeCode(ctx context.Context, d Disk, g GPT) error {
	p, ok := g.Named(MetaPartition)
	if !ok {
		return fmt.Errorf("%s has no %s partition; the image is written without the install code", d.Path, MetaPartition)
	}
	off, length := p.Bytes(g.SectorSize)
	f, err := os.OpenFile(d.Path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	meta := struct {
		io.ReaderAt
		io.WriterAt
	}{io.NewSectionReader(f, off, length), io.NewOffsetWriter(f, off)}
	if err := SetMETA(meta, length, METADownloadURLCode, []byte(e.Code)); err != nil {
		return fmt.Errorf("the install code cannot be written to META: %w", err)
	}
	if err := f.Sync(); err != nil {
		return err
	}
	f.Close()
	e.flushBufs(ctx, d)
	back, err := os.Open(d.Path)
	if err != nil {
		return err
	}
	defer back.Close()
	if got := readADV(io.NewSectionReader(back, off, length))[METADownloadURLCode]; string(got) != e.Code {
		return errors.New("META does not read back the install code")
	}
	e.logf("wrote the install code to META key 0x%02x on partition %d", METADownloadURLCode, p.Number)
	return nil
}

// withMount mounts dev at a directory under RAM, runs fn, syncs and
// unmounts; an unmount that fails fails the step.
func (e *Executor) withMount(dev, fstype, name string, fn func(dir string) error) error {
	dir := filepath.Join(e.RAM, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := e.Host.Mount(dev, dir, fstype, ""); err != nil {
		return fmt.Errorf("%s cannot be mounted: %w", dev, err)
	}
	err := fn(dir)
	e.Host.Sync()
	if uerr := e.Host.Unmount(dir); uerr != nil && err == nil {
		err = fmt.Errorf("%s cannot be unmounted: %w", dev, uerr)
	}
	return err
}

// fetchSeed fetches the NoCloud tar from fleetd with the UUID and the code,
// and takes nothing but a 200.
func (e *Executor) fetchSeed(ctx context.Context, seedURL string) ([]byte, error) {
	u, err := url.Parse(seedURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("uuid", e.UUID)
	q.Set("code", e.Code)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := e.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the seed cannot be fetched (%v); the image is written without a seed", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fleetd answered %d for the seed, not 200; the image is written without a seed", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxSeed+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxSeed {
		return nil, errors.New("the seed is over 8 MiB; the image is written without a seed")
	}
	return b, nil
}

// checkSeed refuses a seed tar with a member outside its directory, or one
// that is neither a directory nor a regular file.
func checkSeed(b []byte) error {
	tr := tar.NewReader(bytes.NewReader(b))
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("the seed tar does not read: %w", err)
		}
		if !filepath.IsLocal(h.Name) {
			return fmt.Errorf("the seed tar names %q, a path outside its directory", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir:
		default:
			return fmt.Errorf("the seed tar's %q is neither a file nor a directory", h.Name)
		}
	}
}

// extractSeed writes a seed tar checkSeed passed under dest and requires
// its user-data and meta-data.
func extractSeed(b []byte, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	tr := tar.NewReader(bytes.NewReader(b))
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dest, filepath.FromSlash(path.Clean(h.Name)))
		if h.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(h.Mode) & 0o644
		f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode|0o600)
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	for _, need := range []string{"user-data", "meta-data"} {
		fi, err := os.Stat(filepath.Join(dest, need))
		if err != nil || fi.Size() == 0 {
			return fmt.Errorf("the seed has no %s", need)
		}
	}
	return nil
}

// ext4Magic is the superblock's magic, 1080 bytes into an ext2, 3 or 4
// file system.
const ext4Magic = 0xef53

// isExt4 says whether the bytes at a partition's start hold an ext
// superblock.
func isExt4(head []byte) bool {
	return len(head) >= 1082 && binary.LittleEndian.Uint16(head[1080:1082]) == ext4Magic
}

// rootPartition is the device of the image's Linux root: the partition of
// the x86-64 root type, or else the largest ext4 partition.
func (e *Executor) rootPartition(d Disk, g GPT) (string, error) {
	if p, ok := g.OfType(TypeLinuxRoot); ok {
		if dev, ok := e.partDevice(d, p.Number); ok {
			return dev, nil
		}
	}
	f, err := os.Open(d.Path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if p, ok := largestExt4(f, g); ok {
		if dev, ok := e.partDevice(d, p.Number); ok {
			return dev, nil
		}
	}
	return "", fmt.Errorf("%s has no Linux root partition; the image is written without a seed", d.Path)
}

// largestExt4 picks the largest partition of the table whose start holds
// an ext superblock.
func largestExt4(r io.ReaderAt, g GPT) (Partition, bool) {
	var best Partition
	var bestLen int64
	head := make([]byte, 1082)
	for _, p := range g.Partitions {
		off, length := p.Bytes(g.SectorSize)
		if _, err := r.ReadAt(head, off); err != nil || !isExt4(head) {
			continue
		}
		if length > bestLen {
			best, bestLen = p, length
		}
	}
	return best, bestLen > 0
}
