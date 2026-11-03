package fleetboot

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const block = 4096

// planSamples picks the 4 KiB blocks a retirement's erase must change:
// sixteen spread over the disk past its first 16 MiB, and three in each
// partition of 64 MiB or more, past the partition's first 32 MiB.
// Partition starts and lengths are in 512-byte sectors, as sysfs counts.
func planSamples(size int64, parts []part) []int64 {
	var out []int64
	for i := int64(1); i <= 16; i++ {
		out = append(out, size*i/17/block+4096)
	}
	for _, p := range parts {
		if p.Length >= 131072 {
			out = append(out, p.Start/8+8192, (p.Start+p.Length/2)/8, (p.Start+p.Length)/8-256)
		}
	}
	return out
}

type canary struct {
	block int64
	sum   [32]byte
}

var zeroBlockSum = sha256.Sum256(make([]byte, block))

func (e *Executor) flushBufs(ctx context.Context, d Disk) {
	_, _ = e.Host.Run(ctx, "blockdev", "--flushbufs", d.Path)
}

// writeCanaries writes random blocks at the samples and records what reads
// back from each.
func (e *Executor) writeCanaries(ctx context.Context, d Disk, samples []int64) ([]canary, error) {
	f, err := os.OpenFile(d.Path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, block)
	for _, s := range samples {
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		if _, err := f.WriteAt(buf, s*block); err != nil {
			return nil, err
		}
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}
	e.flushBufs(ctx, d)
	out := make([]canary, 0, len(samples))
	for _, s := range samples {
		if _, err := f.ReadAt(buf, s*block); err != nil {
			return nil, err
		}
		out = append(out, canary{block: s, sum: sha256.Sum256(buf)})
	}
	return out, nil
}

// verifyErase passes only when every canary reads differently now. A
// canary that read back as zeros was never written, and fails it too.
func (e *Executor) verifyErase(ctx context.Context, d Disk, canaries []canary) (bool, error) {
	e.flushBufs(ctx, d)
	f, err := os.Open(d.Path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	buf := make([]byte, block)
	kept, missing := 0, 0
	for _, c := range canaries {
		if c.sum == zeroBlockSum {
			missing++
			continue
		}
		if _, err := f.ReadAt(buf, c.block*block); err != nil {
			return false, err
		}
		if sha256.Sum256(buf) == c.sum {
			kept++
		}
	}
	e.logf("%d canary blocks written; %d still read as written", len(canaries), kept)
	return len(canaries) > 0 && missing == 0 && kept == 0, nil
}

// eraseMethod tries one way to erase the disk; false means the method is
// unsupported or failed.
type eraseMethod struct {
	name string
	run  func(ctx context.Context, d Disk, size int64, deadline time.Time) bool
}

// erase runs the methods from the strongest to the weakest: an NVMe
// sanitize, an NVMe format, a secure discard, a discard, and a zeroing of
// the disk. A method passes only on evidence: canaries written before it
// must all read differently after it, so a discard the device ignores
// fails and the next one runs. A discard only advises the device; the
// canaries are what decide.
func (e *Executor) erase(ctx context.Context, d Disk, size int64, samples []int64, deadline time.Time) error {
	methods := []eraseMethod{
		{"nvme sanitize", e.nvmeSanitize},
		{"nvme format", e.nvmeFormat},
		{"secure discard", func(ctx context.Context, d Disk, _ int64, deadline time.Time) bool {
			return e.timed(ctx, deadline, "blkdiscard", "--secure", "--force", d.Path)
		}},
		{"discard", func(ctx context.Context, d Disk, _ int64, deadline time.Time) bool {
			return e.timed(ctx, deadline, "blkdiscard", "--force", d.Path)
		}},
		{"overwrite", e.zeroDisk},
	}
	for _, m := range methods {
		if ctx.Err() != nil || e.remaining(deadline) <= 0 {
			return fmt.Errorf("no time is left to erase %s", d.Path)
		}
		canaries, err := e.writeCanaries(ctx, d, samples)
		if err != nil {
			return fmt.Errorf("canary blocks cannot be written to %s: %v", d.Path, err)
		}
		if !m.run(ctx, d, size, deadline) {
			e.logf("%s is unsupported or failed on %s", m.name, d.Path)
			continue
		}
		ok, err := e.verifyErase(ctx, d, canaries)
		if err != nil {
			return err
		}
		if ok {
			e.logf("erased %s by %s", d.Path, m.name)
			return nil
		}
		e.logf("%s ran, but the canary blocks were not erased", m.name)
	}
	return fmt.Errorf("no method erased %s", d.Path)
}

// timed runs a tool with what is left before the deadline, and says
// whether it succeeded.
func (e *Executor) timed(ctx context.Context, deadline time.Time, name string, args ...string) bool {
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	out, err := e.Host.Run(ctx, name, args...)
	if err != nil {
		e.logf("%s: %v %s", name, err, strings.TrimSpace(string(out)))
	}
	return err == nil
}

// nvmeField reads a "name : value" field of nvme-cli's id-ctrl, id-ns or
// sanitize-log output as a number; hex values carry 0x.
func nvmeField(out []byte, name string) (int64, bool) {
	s := bufio.NewScanner(bytes.NewReader(out))
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) >= 3 && f[0] == name && f[1] == ":" {
			if v, err := strconv.ParseInt(f[2], 0, 64); err == nil {
				return v, true
			}
		}
	}
	return 0, false
}

// sanitizeStatus reads SSTAT, the last field of the sanitize log's line
// that names it.
func sanitizeStatus(out []byte) (int64, bool) {
	s := bufio.NewScanner(bytes.NewReader(out))
	for s.Scan() {
		if strings.Contains(s.Text(), "(SSTAT)") {
			f := strings.Fields(s.Text())
			if v, err := strconv.ParseInt(f[len(f)-1], 0, 64); err == nil {
				return v, true
			}
		}
	}
	return 0, false
}

// sanitizeAction is the sanitize action SANICAP allows, crypto erase (4)
// before block erase (2), or 0 for none.
func sanitizeAction(sanicap int64) int {
	switch {
	case sanicap&1 != 0:
		return 4
	case sanicap&2 != 0:
		return 2
	}
	return 0
}

func isNVMe(d Disk) bool { return strings.HasPrefix(d.Name, "nvme") }

func (e *Executor) nvmeSanitize(ctx context.Context, d Disk, _ int64, deadline time.Time) bool {
	if !isNVMe(d) {
		return false
	}
	out, err := e.Host.Run(ctx, "nvme", "id-ctrl", d.Path)
	if err != nil {
		return false
	}
	sanicap, _ := nvmeField(out, "sanicap")
	act := sanitizeAction(sanicap)
	if act == 0 {
		return false
	}
	e.logf("nvme sanitize --sanact=%d %s", act, d.Path)
	if !e.timed(ctx, deadline, "nvme", "sanitize", d.Path, fmt.Sprintf("--sanact=%d", act)) {
		return false
	}
	for e.remaining(deadline) > 0 && ctx.Err() == nil {
		log, err := e.Host.Run(ctx, "nvme", "sanitize-log", d.Path)
		if err == nil {
			if st, ok := sanitizeStatus(log); ok {
				switch st & 7 {
				case 1, 4:
					return true
				case 3:
					e.logf("the sanitize failed")
					_, _ = e.Host.Run(ctx, "nvme", "sanitize", d.Path, "--sanact=1")
					return false
				}
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	e.logf("the sanitize did not finish before the deadline; the controller goes on with it")
	return false
}

// formatArgs are the secure-erase setting and the LBA format an NVMe
// format keeps: a crypto erase when FNA allows it, and the namespace's own
// format from FLBAS. ok is false when OACS has no format.
func formatArgs(oacs, fna, flbas int64) (ses, lbaf int64, ok bool) {
	if oacs&2 == 0 {
		return 0, 0, false
	}
	ses = 1
	if fna&4 != 0 {
		ses = 2
	}
	return ses, (flbas & 15) | (((flbas >> 5) & 3) << 4), true
}

func (e *Executor) nvmeFormat(ctx context.Context, d Disk, _ int64, deadline time.Time) bool {
	if !isNVMe(d) {
		return false
	}
	ctrl, err := e.Host.Run(ctx, "nvme", "id-ctrl", d.Path)
	if err != nil {
		return false
	}
	oacs, _ := nvmeField(ctrl, "oacs")
	fna, _ := nvmeField(ctrl, "fna")
	ns, _ := e.Host.Run(ctx, "nvme", "id-ns", d.Path)
	flbas, _ := nvmeField(ns, "flbas")
	ses, lbaf, ok := formatArgs(oacs, fna, flbas)
	if !ok {
		return false
	}
	ms := e.remaining(deadline).Milliseconds()
	e.logf("nvme format --ses=%d --lbaf=%d %s", ses, lbaf, d.Path)
	return e.timed(ctx, deadline, "nvme", "format", d.Path, fmt.Sprintf("--ses=%d", ses), fmt.Sprintf("--lbaf=%d", lbaf), "--force", fmt.Sprintf("--timeout=%d", ms))
}

// zeroDisk zeroes the disk in 64 MiB chunks, and stops before the deadline
// when the next chunk would not fit, since the kernel cannot interrupt a
// chunk once it starts. A partial zeroing proves nothing and fails.
func (e *Executor) zeroDisk(ctx context.Context, d Disk, size int64, deadline time.Time) bool {
	const chunk = 64 * mib
	var took time.Duration
	for off := int64(0); off < size; {
		if ctx.Err() != nil || e.remaining(deadline) <= 2*took+5*time.Second {
			e.logf("zeroed %d of %d MiB before the deadline; the rest of %s is not erased", off/mib, size/mib, d.Path)
			return false
		}
		n := min(chunk, size-off)
		t0 := e.now()
		if out, err := e.Host.Run(ctx, "blkdiscard", "--zeroout", "--force", "--offset", strconv.FormatInt(off, 10), "--length", strconv.FormatInt(n, 10), d.Path); err != nil {
			e.logf("blkdiscard --zeroout: %v %s", err, strings.TrimSpace(string(out)))
			return false
		}
		took = e.now().Sub(t0)
		off += n
	}
	return true
}
