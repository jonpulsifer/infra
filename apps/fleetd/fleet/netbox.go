package fleet

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/netbox"
)

// NetBox is the system of record: the devices of one site with the role
// kubernetes-node, their lifecycle status and the custom fields of the fleet
// contract (.agent/plans/fleet/spec.md).
type NetBox struct {
	netbox.Client
}

// NewNetBox is the NetBox at url, which token opens.
func NewNetBox(url, token string, hc *http.Client) *NetBox {
	return &NetBox{netbox.Client{URL: url, Token: token, HTTP: hc}}
}

// Device is what fleetd reads from one NetBox device.
type Device = netbox.Device

// Attested is the network facts of a device's last intake pass.
type Attested = netbox.Attested

// Switch is a NetBox device with the role switch.
type Switch = netbox.Switch

// Role is the NetBox device role of a node. Every status here is a device the
// controller keeps Tinkerbell objects for; offline and inventory devices get
// none.
const Role = netbox.Role

var liveStatuses = []string{"planned", "active", "failed", "decommissioning"}

// Devices lists the site's live nodes with the MAC of each one's first
// physical interface that has a primary MAC.
func (n *NetBox) Devices(ctx context.Context, site string) ([]Device, error) {
	q := url.Values{}
	q.Set("site", site)
	q.Set("role", Role)
	for _, s := range liveStatuses {
		q.Add("status", s)
	}
	devices, err := n.Client.Devices(ctx, q)
	if err != nil {
		return nil, err
	}
	if err := n.WithInterfaces(ctx, devices); err != nil {
		return nil, err
	}
	sort.Slice(devices, func(a, b int) bool { return devices[a].Name < devices[b].Name })
	return devices, nil
}

// Find lists the site's nodes, in any status, whose filter field matches the
// value: serial, or a custom field as cf_<name>. NetBox may match loosely, so
// the callers compare the field themselves.
func (n *NetBox) Find(ctx context.Context, site, filter, value string) ([]Device, error) {
	q := url.Values{}
	q.Set("site", site)
	q.Set("role", Role)
	q.Set(filter, value)
	return n.Client.Devices(ctx, q)
}

// ErrNoDevice is a lookup that found no node.
var ErrNoDevice = errors.New("NetBox has no such node")

// BySerial is the site's node with this serial. It is the tolerant lookup:
// NetBox filters the site's nodes loosely and the first whose serial equals
// the request's, ignoring case, wins. The attestation service's strict
// lookup, netbox.Client.SoleBySerial, demands exactly one hit.
func (n *NetBox) BySerial(ctx context.Context, site, serial string) (Device, error) {
	devices, err := n.Find(ctx, site, "serial", serial)
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if strings.EqualFold(d.Serial, serial) {
			one := []Device{d}
			if err := n.WithInterfaces(ctx, one); err != nil {
				return Device{}, err
			}
			return one[0], nil
		}
	}
	return Device{}, ErrNoDevice
}

// ByID is the site's node with this ID, read now.
func (n *NetBox) ByID(ctx context.Context, site string, id int) (Device, error) {
	devices, err := n.Find(ctx, site, "id", fmt.Sprint(id))
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if d.ID == id {
			return d, nil
		}
	}
	return Device{}, ErrNoDevice
}

// BySMBIOSUUID is the site's node whose smbios_uuid is this UUID.
func (n *NetBox) BySMBIOSUUID(ctx context.Context, site, uuid string) (Device, error) {
	devices, err := n.Find(ctx, site, "cf_smbios_uuid", uuid)
	if err != nil {
		return Device{}, err
	}
	for _, d := range devices {
		if d.SMBIOSUUID == strings.ToLower(uuid) {
			return d, nil
		}
	}
	return Device{}, ErrNoDevice
}

// Update patches a device's status and custom fields, and adds a journal
// entry when comment is set.
func (n *NetBox) Update(ctx context.Context, d Device, status string, fields map[string]any, kind, comment string) error {
	if err := n.Patch(ctx, d.ID, status, fields); err != nil {
		return err
	}
	if comment == "" {
		return nil
	}
	return n.Journal(ctx, d.ID, kind, comment)
}

func timestamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }
