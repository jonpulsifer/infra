package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// UniFi reads the gateway's client list to find the switch port a machine
// is plugged into. It is read-only: one GET of the classic API with an API
// key.
type UniFi struct {
	URL    string
	Key    string
	Site   string
	Client *http.Client
}

// Station is one connected client as UniFi's stat/sta reports it. A wired
// client names the switch it is on by sw_mac and the port by sw_port.
type Station struct {
	MAC        string `json:"mac"`
	IP         string `json:"ip"`
	Hostname   string `json:"hostname"`
	Wired      bool   `json:"is_wired"`
	SwitchMAC  string `json:"sw_mac"`
	SwitchPort int    `json:"sw_port"`
}

// Stations lists the site's connected clients.
func (u *UniFi) Stations(ctx context.Context) ([]Station, error) {
	site := u.Site
	if site == "" {
		site = "default"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(u.URL, "/")+"/proxy/network/api/s/"+site+"/stat/sta", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-KEY", u.Key)
	req.Header.Set("Accept", "application/json")
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("UniFi stat/sta: %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	var body struct {
		Meta struct {
			RC  string `json:"rc"`
			Msg string `json:"msg"`
		} `json:"meta"`
		Data []Station `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("UniFi stat/sta: %w", err)
	}
	if body.Meta.RC != "ok" {
		return nil, fmt.Errorf("UniFi stat/sta: rc %q %s", body.Meta.RC, body.Meta.Msg)
	}
	for i := range body.Data {
		body.Data[i].MAC = strings.ToLower(body.Data[i].MAC)
		body.Data[i].SwitchMAC = strings.ToLower(body.Data[i].SwitchMAC)
	}
	return body.Data, nil
}

// Port is where UniFi sees the MAC wired: the switch's MAC and the port,
// or ok false.
func Port(stations []Station, mac string) (switchMAC string, port int, ok bool) {
	for _, s := range stations {
		if s.MAC == mac && s.Wired && s.SwitchMAC != "" && s.SwitchPort > 0 {
			return s.SwitchMAC, s.SwitchPort, true
		}
	}
	return "", 0, false
}
