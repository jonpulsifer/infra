package netbox

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// ErrMACTaken is a device interface that holds another MAC.
var ErrMACTaken = errors.New("the interface holds another MAC")

// NormalMAC is a MAC in lower case with colons.
func NormalMAC(m string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(m), "-", ":"))
}

var macRE = regexp.MustCompile(`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`)

// ValidMAC is whether a MAC reads as six hex bytes, colon- or
// hyphen-separated, before it is written anywhere.
func ValidMAC(mac string) bool {
	return macRE.MatchString(NormalMAC(mac))
}

// Interface is a device interface and its primary MAC.
type Interface struct {
	ID                int    `json:"id"`
	Name              string `json:"name"`
	PrimaryMACAddress *struct {
		ID         int    `json:"id"`
		MACAddress string `json:"mac_address"`
	} `json:"primary_mac_address"`
}

// NIC is the device's first interface with a primary MAC. Without one it is
// the first interface, and hasMAC is false; without any, the zero Interface.
func (c *Client) NIC(ctx context.Context, deviceID int) (i Interface, hasMAC bool, err error) {
	var page Page[Interface]
	if err := c.Do(ctx, http.MethodGet, fmt.Sprintf("/api/dcim/interfaces/?limit=50&device_id=%d", deviceID), nil, &page); err != nil {
		return Interface{}, false, err
	}
	results, err := page.Items()
	if err != nil {
		return Interface{}, false, err
	}
	sort.Slice(results, func(i, j int) bool { return results[i].ID < results[j].ID })
	for _, i := range results {
		if i.PrimaryMACAddress != nil && i.PrimaryMACAddress.MACAddress != "" {
			return i, true, nil
		}
	}
	if len(results) > 0 {
		return results[0], false, nil
	}
	return Interface{}, false, nil
}

// SetMAC puts mac, already normal, on the device's first interface as its
// primary MAC, making an interface when the device type's templates made
// none, and reports whether it wrote. The same MAC on file is no write;
// another is ErrMACTaken.
func (c *Client) SetMAC(ctx context.Context, deviceID int, mac string) (bool, error) {
	i, hasMAC, err := c.NIC(ctx, deviceID)
	if err != nil {
		return false, err
	}
	if hasMAC {
		if NormalMAC(i.PrimaryMACAddress.MACAddress) == mac {
			return false, nil
		}
		return false, fmt.Errorf("interface %s already has MAC %s: %w", i.Name, i.PrimaryMACAddress.MACAddress, ErrMACTaken)
	}
	if i.ID == 0 {
		if err := c.Do(ctx, http.MethodPost, "/api/dcim/interfaces/", map[string]any{"device": deviceID, "name": "eth0", "type": "1000base-t"}, &i); err != nil {
			return false, err
		}
	}
	var m struct {
		ID int `json:"id"`
	}
	if err := c.Do(ctx, http.MethodPost, "/api/dcim/mac-addresses/", map[string]any{
		"mac_address":          strings.ToUpper(mac),
		"assigned_object_type": "dcim.interface",
		"assigned_object_id":   i.ID,
	}, &m); err != nil {
		return false, err
	}
	if err := c.Do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/interfaces/%d/", i.ID), map[string]any{"primary_mac_address": m.ID}, nil); err != nil {
		return false, err
	}
	// Two sessions binding at once can both get this far: the write stands
	// only when the interface holds one MAC, this one, as its primary.
	if err := c.soleMAC(ctx, deviceID, i.ID, mac); err != nil {
		return false, err
	}
	return true, nil
}

// soleMAC checks that the device's first MAC interface is ifaceID, that its
// primary MAC is mac, and that no other MAC is assigned to it.
func (c *Client) soleMAC(ctx context.Context, deviceID, ifaceID int, mac string) error {
	i, hasMAC, err := c.NIC(ctx, deviceID)
	if err != nil {
		return err
	}
	if !hasMAC || i.ID != ifaceID || NormalMAC(i.PrimaryMACAddress.MACAddress) != mac {
		return fmt.Errorf("interface %d does not hold MAC %s as its primary after the write: %w", ifaceID, mac, ErrMACTaken)
	}
	var page Page[struct {
		MACAddress string `json:"mac_address"`
	}]
	if err := c.Do(ctx, http.MethodGet, fmt.Sprintf("/api/dcim/mac-addresses/?limit=10&assigned_object_type=dcim.interface&assigned_object_id=%d", ifaceID), nil, &page); err != nil {
		return err
	}
	macs, err := page.Items()
	if err != nil {
		return err
	}
	if len(macs) != 1 || NormalMAC(macs[0].MACAddress) != mac {
		return fmt.Errorf("interface %s holds %d MACs after the write: %w", i.Name, len(macs), ErrMACTaken)
	}
	return nil
}
