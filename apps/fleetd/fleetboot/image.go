package fleetboot

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

var (
	codePattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	digestPattern  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	seedURLPattern = regexp.MustCompile(`^https://[A-Za-z0-9:/._%~-]+$`)
	uuidPattern    = regexp.MustCompile(`^[0-9a-f-]+$`)
)

// preflight refuses a run whose install inputs are malformed before the
// wipe, so a refused run keeps its disk. The Templates check the same
// inputs after the wipe; checking first loses nothing.
func preflight(r protocol.BootRun, code string) error {
	if r.Install && !r.Wipe {
		return errors.New("the run installs without wiping; nothing wiped")
	}
	if !r.Install {
		return nil
	}
	if code == "" {
		return errors.New("no install code: the boot's attestation got none (no intake pass, or fleetd refused the render); nothing wiped")
	}
	if !codePattern.MatchString(code) {
		return errors.New("the install code is malformed; nothing wiped")
	}
	if r.ImageURL == "" && r.InstallerImage != "" {
		return fmt.Errorf("the run installs the container %s, and fleet-boot runs no containers; nothing wiped", r.InstallerImage)
	}
	switch {
	case !digestPattern.MatchString(r.ImageDigest):
		return fmt.Errorf("the image digest %q is not sha256:<64 lower-case hex>; nothing wiped", r.ImageDigest)
	case !strings.HasPrefix(r.ImageURL, "https://"):
		return fmt.Errorf("the image URL %q is not https; nothing wiped", r.ImageURL)
	case !slices.Contains(classes.ImageFormats, r.ImageFormat):
		return fmt.Errorf("the image format %q is unknown; nothing wiped", r.ImageFormat)
	case !classes.ImagePayload(r.PayloadKind) && r.PayloadKind != classes.PayloadTalosConfig:
		return fmt.Errorf("the payload kind %q is not an image's; nothing wiped", r.PayloadKind)
	case r.PayloadKind == classes.PayloadTalosConfig:
		// A Talos image's seed is the code in META; its config URL is in its UKI.
	case !strings.HasPrefix(r.SeedURL, "https://"):
		return fmt.Errorf("the seed URL %q is not https; nothing wiped", r.SeedURL)
	case !seedURLPattern.MatchString(r.SeedURL):
		return errors.New("the seed URL is malformed; nothing wiped")
	}
	return nil
}

// Magic numbers of the packed formats.
var (
	magicZstd = []byte{0x28, 0xb5, 0x2f, 0xfd}
	magicGzip = []byte{0x1f, 0x8b}
	magicXZ   = []byte{0xfd, '7', 'z', 'X', 'Z', 0x00}
)

// DetectFormat names the format a file's first bytes say it has: raw.zst,
// raw.gz, tar.xz, or raw for a disk with a protective MBR's signature or
// a GPT header at 512 or 4096 bytes. "" is none of these.
func DetectFormat(head []byte) string {
	switch {
	case bytes.HasPrefix(head, magicZstd):
		return "raw.zst"
	case bytes.HasPrefix(head, magicGzip):
		return "raw.gz"
	case bytes.HasPrefix(head, magicXZ):
		return "tar.xz"
	case len(head) >= 520 && bytes.Equal(head[512:520], []byte("EFI PART")):
		return "raw"
	case len(head) >= 4104 && bytes.Equal(head[4096:4104], []byte("EFI PART")):
		return "raw"
	case len(head) >= 512 && head[510] == 0x55 && head[511] == 0xaa:
		return "raw"
	}
	return ""
}

// decodeCommands is the pipeline that unpacks a format on stdout, from the
// file at path: the raw disk for raw, zstd and gzip, and for a tar.xz the
// tarball, whose one member writeDisk reads.
func decodeCommands(format, path string) [][]string {
	switch format {
	case "raw":
		return [][]string{{"cat", path}}
	case "raw.zst":
		return [][]string{{"zstd", "-dc", path}}
	case "raw.gz":
		return [][]string{{"gzip", "-dc", path}}
	case "tar.xz":
		return [][]string{{"xz", "-dc", path}}
	}
	return nil
}

// pipeline runs commands with each one's stdout feeding the next, and
// answers the last one's stdout and a wait that fails when any of them did.
// The parent keeps no end of an inner pipe, so a command that stops early
// ends the one that feeds it.
func pipeline(ctx context.Context, cmds [][]string) (io.ReadCloser, func() error, error) {
	if len(cmds) == 0 {
		return nil, nil, errors.New("no command")
	}
	procs := make([]*exec.Cmd, len(cmds))
	stderrs := make([]*bytes.Buffer, len(cmds))
	var inner []*os.File
	closeInner := func() {
		for _, f := range inner {
			f.Close()
		}
	}
	for i, c := range cmds {
		procs[i] = exec.CommandContext(ctx, c[0], c[1:]...)
		stderrs[i] = &bytes.Buffer{}
		procs[i].Stderr = stderrs[i]
		if i > 0 {
			r, w, err := os.Pipe()
			if err != nil {
				closeInner()
				return nil, nil, err
			}
			procs[i-1].Stdout = w
			procs[i].Stdin = r
			inner = append(inner, r, w)
		}
	}
	out, err := procs[len(procs)-1].StdoutPipe()
	if err != nil {
		closeInner()
		return nil, nil, err
	}
	started := 0
	for _, p := range procs {
		if err := p.Start(); err != nil {
			closeInner()
			for _, q := range procs[:started] {
				_ = q.Process.Kill()
				_ = q.Wait()
			}
			return nil, nil, fmt.Errorf("start %s: %w", p.Path, err)
		}
		started++
	}
	closeInner()
	wait := func() error {
		var errs []error
		for i, p := range procs {
			if err := p.Wait(); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w: %s", cmds[i][0], err, strings.TrimSpace(stderrs[i].String())))
			}
		}
		return errors.Join(errs...)
	}
	return out, wait, nil
}

// diskMember reads a tarball's first member, which must be a file: a
// cloud image's disk is a GNU sparse member, whose holes the reader fills
// with zeros.
func diskMember(tr *tar.Reader) (io.Reader, error) {
	h, err := tr.Next()
	if err != nil {
		return nil, fmt.Errorf("the tarball has no member: %w", err)
	}
	switch h.Typeflag {
	case tar.TypeReg, tar.TypeGNUSparse, '\x00':
		return tr, nil
	}
	return nil, fmt.Errorf("the tarball's first member %q is no file", h.Name)
}

// onlyMember says whether a tarball holds nothing after the member read.
func onlyMember(tr *tar.Reader) error {
	h, err := tr.Next()
	switch {
	case errors.Is(err, io.EOF):
		return nil
	case err != nil:
		return err
	}
	return fmt.Errorf("the tarball has a second member, %q, so it is no one disk image", h.Name)
}

// download fetches url into path with at most max bytes and answers the
// file's sha256 in hex.
func download(ctx context.Context, c *http.Client, url, path string, max int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %d", url, resp.StatusCode)
	}
	if resp.ContentLength > max {
		return "", fmt.Errorf("the image is %d bytes, over the %d this machine's memory takes", resp.ContentLength, max)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, max+1))
	if err != nil {
		return "", err
	}
	if n > max {
		return "", fmt.Errorf("the image is over the %d bytes this machine's memory takes", max)
	}
	return hex.EncodeToString(h.Sum(nil)), f.Close()
}

// writeHeadroom is memory a download leaves for the disk write's page cache
// and fleet-boot itself.
const writeHeadroom = 512 * mib

// MemoryBudget is how much a download may take: a quarter less than the
// memory /proc/meminfo says is available, less writeHeadroom, and no more
// than the RAM directory's file system has free.
func MemoryBudget(meminfo []byte, tmpfsFree int64) (int64, error) {
	s := bufio.NewScanner(bytes.NewReader(meminfo))
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) == 3 && f[0] == "MemAvailable:" && f[2] == "kB" {
			kb, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil {
				return 0, err
			}
			avail := kb * 1024
			return max(0, min(avail-avail/4-writeHeadroom, tmpfsFree)), nil
		}
	}
	return 0, errors.New("/proc/meminfo has no MemAvailable")
}

// install writes the class's image to the wiped disk, then the seed.
func (e *Executor) install(ctx context.Context, r protocol.BootRun) (string, error) {
	if !r.Install {
		return "nothing installed this run", nil
	}
	if !e.wiped {
		return "", errors.New("this run's wipe did not run in this boot; nothing installed; set desired_action to provision")
	}
	d, err := e.checkDisk(r.Disk, r.DiskSerial, "nothing installed")
	if err != nil {
		return "", err
	}
	if e.UUID == "" || !uuidPattern.MatchString(e.UUID) {
		return "", fmt.Errorf("the product UUID %q is malformed; nothing installed", e.UUID)
	}
	img := filepath.Join(e.RAM, "image")
	defer os.Remove(img)
	e.logf("downloading %s", r.ImageURL)
	got, err := download(ctx, e.HTTP, r.ImageURL, img, e.MaxImage)
	if err != nil {
		return "", fmt.Errorf("the image cannot be downloaded (%v); nothing written", err)
	}
	if want := strings.TrimPrefix(r.ImageDigest, "sha256:"); got != want {
		return "", fmt.Errorf("the image's sha256 is %s, not %s; nothing written", got, want)
	}
	e.logf("the image matches %s", r.ImageDigest)
	head := make([]byte, 4104)
	if f, err := os.Open(img); err == nil {
		n, _ := io.ReadFull(f, head)
		head = head[:n]
		f.Close()
	}
	if got := DetectFormat(head); got != r.ImageFormat {
		return "", fmt.Errorf("the image's first bytes say %q, and the class says %q; nothing written", got, r.ImageFormat)
	}
	e.logf("writing %s to %s", r.ImageFormat, d.Path)
	if err := e.writeDisk(ctx, d, r.ImageFormat, img); err != nil {
		return "", err
	}
	os.Remove(img)
	e.Host.Sync()
	if out, err := e.Host.Run(ctx, "sgdisk", "-e", d.Path); err != nil {
		e.logf("the backup GPT could not be moved to the end of %s: %v %s", d.Path, err, strings.TrimSpace(string(out)))
	}
	_, _ = e.Host.Run(ctx, "blockdev", "--rereadpt", d.Path)
	g, esp, espDev, err := e.waitESP(ctx, d)
	if err != nil {
		return "", err
	}
	e.logf("the EFI system partition is %s", espDev)
	e.esp = &installedESP{disk: d, Partition: esp}
	if err := e.seed(ctx, r, d, g, esp, espDev); err != nil {
		return "", err
	}
	return fmt.Sprintf("installed %s image to %s", r.ImageFormat, d.Path), nil
}

// writeDisk streams the unpacked image onto the disk and syncs it.
func (e *Executor) writeDisk(ctx context.Context, d Disk, format, img string) error {
	out, wait, err := pipeline(ctx, decodeCommands(format, img))
	if err != nil {
		return fmt.Errorf("the image cannot be unpacked (%v); nothing written", err)
	}
	var src io.Reader = out
	var tr *tar.Reader
	if format == "tar.xz" {
		tr = tar.NewReader(out)
		if src, err = diskMember(tr); err != nil {
			out.Close()
			_ = wait()
			return fmt.Errorf("%v; nothing written", err)
		}
	}
	f, err := os.OpenFile(d.Path, os.O_WRONLY, 0)
	if err != nil {
		out.Close()
		_ = wait()
		return fmt.Errorf("open %s: %w; nothing written", d.Path, err)
	}
	_, cerr := io.CopyBuffer(f, src, make([]byte, 4<<20))
	var merr error
	if cerr == nil && tr != nil {
		merr = onlyMember(tr)
	}
	// The decompressor writes the tarball's end blocks too.
	_, _ = io.Copy(io.Discard, out)
	out.Close()
	serr := f.Sync()
	f.Close()
	werr := wait()
	switch {
	case merr != nil:
		return fmt.Errorf("%v; the disk is partly written", merr)
	case cerr != nil:
		return fmt.Errorf("writing %s failed (%v); the disk is partly written", d.Path, cerr)
	case werr != nil:
		return fmt.Errorf("the image did not unpack (%v); the disk is partly written", werr)
	case serr != nil:
		return fmt.Errorf("syncing %s failed (%v); the disk is partly written", d.Path, serr)
	}
	return nil
}

// waitESP reads the written disk's GPT and waits up to 30 seconds for the
// kernel's node of its EFI system partition.
func (e *Executor) waitESP(ctx context.Context, d Disk) (GPT, Partition, string, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		f, err := os.Open(d.Path)
		if err == nil {
			var g GPT
			g, err = ReadGPT(f, d.SectorSize)
			f.Close()
			if err == nil {
				esp, ok := g.OfType(TypeESP)
				if !ok {
					return GPT{}, Partition{}, "", fmt.Errorf("%s has no EFI system partition after the write", d.Path)
				}
				if dev, ok := e.partDevice(d, esp.Number); ok {
					return g, esp, dev, nil
				}
				err = fmt.Errorf("the kernel has no node for partition %d", esp.Number)
			}
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return GPT{}, Partition{}, "", ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return GPT{}, Partition{}, "", fmt.Errorf("%s has no EFI system partition after the write: %v", d.Path, lastErr)
}
