package fleet

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// KeaReservations writes Kea's host reservations for the devices NetBox
// holds, and has Kea reload its configuration when the file changes. Kea
// splices File into its subnet with an include directive, so a reservation
// gives a device's MAC its NetBox address, and the boot file while the
// device has an unfinished Workflow, the condition that allows netboot.
type KeaReservations struct {
	// File is the JSON array Kea includes.
	File string
	// Socket is Kea's unix control socket, or empty to reload nothing.
	Socket string
	// BootFile is the boot-file-name a reservation carries while its
	// device may netboot: the signed iPXE under the TFTP root.
	BootFile string
	// Dial opens the control socket; nil dials the unix socket.
	Dial func(network, addr string) (net.Conn, error)
}

type keaReservation struct {
	HWAddress    string `json:"hw-address"`
	IPAddress    string `json:"ip-address"`
	Hostname     string `json:"hostname,omitempty"`
	BootFileName string `json:"boot-file-name,omitempty"`
}

// Reservations is the array Sync writes for devices: one entry per device
// with a MAC and an address, by name, with the boot file for those netboot
// names. A device with a malformed MAC or address is an error and left out.
func (k *KeaReservations) Reservations(devices []Device, netboot map[string]bool) ([]keaReservation, error) {
	var out []keaReservation
	var errs []error
	for _, d := range devices {
		if d.MAC == "" || d.Address == "" {
			continue
		}
		mac := strings.ToLower(d.MAC)
		if !macName.MatchString(mac) {
			errs = append(errs, fmt.Errorf("kea reservation %s: %q is not a MAC", d.Name, d.MAC))
			continue
		}
		addr, err := netip.ParseAddr(d.Address)
		if err != nil || !addr.Is4() {
			errs = append(errs, fmt.Errorf("kea reservation %s: %q is not an IPv4 address", d.Name, d.Address))
			continue
		}
		r := keaReservation{HWAddress: mac, IPAddress: addr.String(), Hostname: d.Name}
		if netboot[d.Name] {
			r.BootFileName = k.BootFile
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Hostname < out[j].Hostname })
	if out == nil {
		out = []keaReservation{}
	}
	return out, errors.Join(errs...)
}

// Sync writes the reservations and reloads Kea when they changed. The file
// is written beside itself and renamed, so Kea reads a whole file or the
// old one. An unchanged file sends no reload.
func (k *KeaReservations) Sync(devices []Device, netboot map[string]bool) error {
	reservations, rerr := k.Reservations(devices, netboot)
	body, err := json.MarshalIndent(reservations, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	if old, err := os.ReadFile(k.File); err == nil && bytes.Equal(old, body) {
		return rerr
	}
	tmp := filepath.Join(filepath.Dir(k.File), "."+filepath.Base(k.File)+".tmp")
	if err := os.WriteFile(tmp, body, 0o640); err != nil {
		return errors.Join(rerr, err)
	}
	if err := os.Rename(tmp, k.File); err != nil {
		_ = os.Remove(tmp)
		return errors.Join(rerr, err)
	}
	if k.Socket == "" {
		return rerr
	}
	if err := k.reload(); err != nil {
		return errors.Join(rerr, fmt.Errorf("kea reload: %w", err))
	}
	return rerr
}

// reload sends config-reload over the control socket and requires Kea's
// result 0, so a reservations file Kea rejects is an error the pass reports
// rather than a silent old configuration.
func (k *KeaReservations) reload() error {
	dial := k.Dial
	if dial == nil {
		dial = func(network, addr string) (net.Conn, error) {
			return net.DialTimeout(network, addr, 5*time.Second)
		}
	}
	conn, err := dial("unix", k.Socket)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(conn).Encode(map[string]string{"command": "config-reload"}); err != nil {
		return err
	}
	var answer struct {
		Result int    `json:"result"`
		Text   string `json:"text"`
	}
	if err := json.NewDecoder(conn).Decode(&answer); err != nil {
		return fmt.Errorf("read the answer: %w", err)
	}
	if answer.Result != 0 {
		return fmt.Errorf("result %d: %s", answer.Result, answer.Text)
	}
	return nil
}
