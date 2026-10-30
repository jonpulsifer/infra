package fleet

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// The NetBox call of an admission: the switches whose chassis IDs LLDP names.

// Switch is a NetBox device with the role switch and the MACs of its
// interfaces, one of which is the chassis ID its LLDP frames carry.
type Switch struct {
	ID   int
	Name string
	MACs map[string]bool
}

type rawInterface struct {
	Device struct {
		ID int `json:"id"`
	} `json:"device"`
	PrimaryMAC *struct {
		MAC string `json:"mac_address"`
	} `json:"primary_mac_address"`
}

// Switches lists the site's switches.
func (n *NetBox) Switches(ctx context.Context, site string) ([]Switch, error) {
	var raws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/devices/?site="+url.QueryEscape(site)+"&role=switch", &raws); err != nil {
		return nil, err
	}
	switches := make([]Switch, 0, len(raws))
	q := url.Values{}
	for _, raw := range raws {
		var d struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return nil, err
		}
		switches = append(switches, Switch{ID: d.ID, Name: d.Name, MACs: map[string]bool{}})
		q.Add("device_id", fmt.Sprint(d.ID))
	}
	if len(switches) == 0 {
		return switches, nil
	}
	var iraws []json.RawMessage
	if err := n.list(ctx, "/api/dcim/interfaces/?"+q.Encode(), &iraws); err != nil {
		return nil, err
	}
	for _, raw := range iraws {
		var i rawInterface
		if err := json.Unmarshal(raw, &i); err != nil {
			return nil, err
		}
		if i.PrimaryMAC == nil {
			continue
		}
		for k := range switches {
			if switches[k].ID == i.Device.ID {
				switches[k].MACs[strings.ToLower(i.PrimaryMAC.MAC)] = true
			}
		}
	}
	return switches, nil
}
