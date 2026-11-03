// Package netbox is fleetd's one adapter for the NetBox device record: the
// HTTP transport, paging, the device decoder and the writes that fleet and
// attest share.
package netbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// Client is one NetBox API.
type Client struct {
	URL   string
	Token string
	HTTP  *http.Client
}

// Error is a NetBox answer that is not a 2xx, with its HTTP status kept.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

// StatusOf is the HTTP status of a NetBox refusal in err's chain, 0 when err
// holds none.
func StatusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

// Do sends one request. NetBox 4.5's v2 tokens start nbt_ and go as Bearer;
// older tokens as Token.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.URL, "/")+path, rd)
	if err != nil {
		return err
	}
	scheme := "Token"
	if strings.HasPrefix(c.Token, "nbt_") {
		scheme = "Bearer"
	}
	req.Header.Set("Authorization", scheme+" "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &Error{Status: resp.StatusCode, Msg: fmt.Sprintf("%s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(msg)))}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// List follows a list endpoint's next links. The link names whatever host the
// request claimed to be, so only its path and query are used.
func (c *Client) List(ctx context.Context, path string, out *[]json.RawMessage) error {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	next := path + sep + "limit=100"
	for i := 0; next != ""; i++ {
		if i > 1000 {
			return fmt.Errorf("%s: more than 1000 pages", path)
		}
		var page struct {
			Next    *string           `json:"next"`
			Results []json.RawMessage `json:"results"`
		}
		if err := c.Do(ctx, http.MethodGet, next, nil, &page); err != nil {
			return err
		}
		*out = append(*out, page.Results...)
		next = ""
		if page.Next != nil && *page.Next != "" {
			u, err := url.Parse(*page.Next)
			if err != nil {
				return fmt.Errorf("next link %q: %w", *page.Next, err)
			}
			next = u.RequestURI()
		}
	}
	return nil
}

// Page is one page of a list. A page without count or results is not an
// answer: a 200 with {} or null never reads as "no such device".
type Page[T any] struct {
	Count   *int `json:"count"`
	Results *[]T `json:"results"`
}

// Items are the page's results.
func (p Page[T]) Items() ([]T, error) {
	if p.Count == nil || p.Results == nil {
		return nil, errors.New("NetBox answered a page without count or results")
	}
	return *p.Results, nil
}

// Devices lists the devices a query selects, without their interfaces.
func (c *Client) Devices(ctx context.Context, q url.Values) ([]Device, error) {
	var raws []json.RawMessage
	if err := c.List(ctx, "/api/dcim/devices/?"+q.Encode(), &raws); err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(raws))
	for _, raw := range raws {
		d, err := ParseDevice(raw)
		if err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// SoleBySerial is the one device with this serial, whatever its site or role.
// This is the strict lookup: NetBox must report exactly one hit, and two
// hits, or a count that disagrees with the results, are an error. No hit is
// ok == false. The match is NetBox's own, so it is as loose as NetBox's
// serial filter. The read fails closed: see ParseDeviceStrict.
func (c *Client) SoleBySerial(ctx context.Context, serial string) (Device, bool, error) {
	var page Page[json.RawMessage]
	if err := c.Do(ctx, http.MethodGet, "/api/dcim/devices/?limit=2&serial="+url.QueryEscape(serial), nil, &page); err != nil {
		return Device{}, false, err
	}
	results, err := page.Items()
	if err != nil {
		return Device{}, false, err
	}
	if *page.Count == 0 && len(results) == 0 {
		return Device{}, false, nil
	}
	if *page.Count != 1 || len(results) != 1 {
		return Device{}, false, fmt.Errorf("NetBox has %d devices with serial %s", *page.Count, serial)
	}
	d, err := ParseDeviceStrict(results[0])
	if err != nil {
		return Device{}, false, err
	}
	return d, true, nil
}

// WithInterfaces fills in each device's MAC from its first physical
// interface that has a primary MAC.
func (c *Client) WithInterfaces(ctx context.Context, devices []Device) error {
	if len(devices) == 0 {
		return nil
	}
	byID := map[int]int{}
	for i, d := range devices {
		byID[d.ID] = i
	}
	iq := url.Values{}
	iq.Set("type__n", "virtual")
	for _, d := range devices {
		iq.Add("device_id", fmt.Sprint(d.ID))
	}
	var iraws []json.RawMessage
	if err := c.List(ctx, "/api/dcim/interfaces/?"+iq.Encode(), &iraws); err != nil {
		return err
	}
	type iface struct {
		ID     int `json:"id"`
		Device struct {
			ID int `json:"id"`
		} `json:"device"`
		PrimaryMAC *struct {
			MAC string `json:"mac_address"`
		} `json:"primary_mac_address"`
	}
	var ifaces []iface
	for _, raw := range iraws {
		var i iface
		if err := json.Unmarshal(raw, &i); err != nil {
			return err
		}
		if i.PrimaryMAC != nil && i.PrimaryMAC.MAC != "" {
			ifaces = append(ifaces, i)
		}
	}
	sort.Slice(ifaces, func(a, b int) bool { return ifaces[a].ID < ifaces[b].ID })
	for _, i := range ifaces {
		idx, ok := byID[i.Device.ID]
		if ok && devices[idx].MAC == "" {
			devices[idx].MAC = strings.ToLower(i.PrimaryMAC.MAC)
		}
	}
	return nil
}

// Switch is a NetBox device with the role switch and the MACs of its
// interfaces, one of which is the chassis ID its LLDP frames carry.
type Switch struct {
	ID   int
	Name string
	MACs map[string]bool
}

// Switches lists the site's switches.
func (c *Client) Switches(ctx context.Context, site string) ([]Switch, error) {
	var raws []json.RawMessage
	if err := c.List(ctx, "/api/dcim/devices/?site="+url.QueryEscape(site)+"&role=switch", &raws); err != nil {
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
	if err := c.List(ctx, "/api/dcim/interfaces/?"+q.Encode(), &iraws); err != nil {
		return nil, err
	}
	for _, raw := range iraws {
		var i struct {
			Device struct {
				ID int `json:"id"`
			} `json:"device"`
			PrimaryMAC *struct {
				MAC string `json:"mac_address"`
			} `json:"primary_mac_address"`
		}
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

// Patch writes a device's status and custom fields. Nothing to write is no
// request.
func (c *Client) Patch(ctx context.Context, id int, status string, fields map[string]any) error {
	patch := map[string]any{}
	if status != "" {
		patch["status"] = status
	}
	if len(fields) > 0 {
		patch["custom_fields"] = fields
	}
	if len(patch) == 0 {
		return nil
	}
	return c.Do(ctx, http.MethodPatch, fmt.Sprintf("/api/dcim/devices/%d/", id), patch, nil)
}

// Journal adds a journal entry to a device.
func (c *Client) Journal(ctx context.Context, id int, kind, comment string) error {
	return c.Do(ctx, http.MethodPost, "/api/extras/journal-entries/", map[string]any{
		"assigned_object_type": "dcim.device",
		"assigned_object_id":   id,
		"kind":                 kind,
		"comments":             comment,
	}, nil)
}
