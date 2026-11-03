package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// efiGlobal is the EFI global variable GUID, under which the boot entries
// and BootCurrent live.
const efiGlobal = "8be4df61-93ca-11d2-aa0d-00e098032b8c"

// loadOptionMAC is the MAC in the first MAC address node of an
// EFI_LOAD_OPTION's device path, as efivarfs gives a Boot#### variable: four
// bytes of variable attributes, then the option's attributes (4), its path
// list's length (2), its NUL-ended UTF-16 description, and the path's nodes,
// each a type, a subtype and a 2-byte length. A messaging (3) MAC (11) node
// holds a 32-byte address and the interface type, 1 for Ethernet's six
// bytes.
func loadOptionMAC(v []byte) (string, bool) {
	if len(v) < 10 {
		return "", false
	}
	opt := v[4:]
	pathLen := int(binary.LittleEndian.Uint16(opt[4:6]))
	i := 6
	for ; i+1 < len(opt); i += 2 {
		if opt[i] == 0 && opt[i+1] == 0 {
			i += 2
			break
		}
	}
	if i+pathLen > len(opt) {
		return "", false
	}
	path := opt[i : i+pathLen]
	for len(path) >= 4 {
		typ, sub, n := path[0], path[1], int(binary.LittleEndian.Uint16(path[2:4]))
		if n < 4 || n > len(path) {
			return "", false
		}
		if typ == 0x7f && sub == 0xff {
			break
		}
		if typ == 3 && sub == 11 && n >= 4+33 && path[4+32] == 1 {
			return net.HardwareAddr(path[4:10]).String(), true
		}
		path = path[n:]
	}
	return "", false
}

// firmwareBootMAC is the MAC of the NIC the firmware booted from: the MAC
// node of the entry BootCurrent names, read from efivarfs.
func firmwareBootMAC(efivars string) (string, bool) {
	cur, err := os.ReadFile(filepath.Join(efivars, "BootCurrent-"+efiGlobal))
	if err != nil || len(cur) != 6 {
		return "", false
	}
	entry, err := os.ReadFile(filepath.Join(efivars, fmt.Sprintf("Boot%04X-%s", binary.LittleEndian.Uint16(cur[4:6]), efiGlobal)))
	if err != nil {
		return "", false
	}
	return loadOptionMAC(entry)
}

// defaultRouteInterfaces are the interfaces of the IPv4 default routes that
// are up in a /proc/net/route table, in its order.
func defaultRouteInterfaces(r io.Reader) []string {
	var out []string
	s := bufio.NewScanner(r)
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) < 4 || f[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err == nil && flags&0x1 != 0 {
			out = append(out, f[0])
		}
	}
	return out
}

// candidateMACs orders the MACs the machine may have booted from: the
// firmware's boot NIC first, then each NIC holding a default route, once
// each. Every ether link DHCPs, so a second cabled NIC holds a route too.
func candidateMACs(firmware string, routed []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range append([]string{firmware}, routed...) {
		m = strings.ToLower(strings.TrimSpace(m))
		if m != "" && !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// bootMACs waits for a default route and answers the candidate boot MACs.
func bootMACs(ctx context.Context, efivars string, wait time.Duration) ([]string, error) {
	deadline := time.Now().Add(wait)
	firmware, _ := firmwareBootMAC(efivars)
	for {
		var routed []string
		if f, err := os.Open("/proc/net/route"); err == nil {
			for _, ifname := range defaultRouteInterfaces(f) {
				if b, err := os.ReadFile("/sys/class/net/" + ifname + "/address"); err == nil {
					routed = append(routed, string(b))
				}
			}
			f.Close()
		}
		if len(routed) > 0 {
			return candidateMACs(firmware, routed), nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("no default route after %s", wait)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
