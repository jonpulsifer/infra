package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigReadsTheDHCPPrefix(t *testing.T) {
	for _, k := range []string{"FLEET_HOOKOS_URL", "FLEET_HOOKOS_CMDLINE", "FLEET_ATTEST_URL", "FLEET_NTP_SERVER"} {
		t.Setenv(k, "x")
	}
	for v, ok := range map[string]bool{"": true, "192.0.2.48/28": true, "192.0.2.49/28": false, "2001:db8::/64": false, "pool": false} {
		t.Setenv("FLEET_NODE_DHCP_PREFIX", v)
		c, err := loadConfig()
		if (err == nil) != ok || ok && v != "" && c.NodeDHCP.String() != v {
			t.Errorf("FLEET_NODE_DHCP_PREFIX=%q: %v, err %v", v, c.NodeDHCP, err)
		}
	}
}

// The cluster's credentials come all together or not at all: a half-set
// environment is a mistake, not a choice to skip the cordon.
func TestLoadClusterNeedsAllThree(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	_ = os.WriteFile(token, []byte("t\n"), 0o600)
	t.Setenv("FLEET_CLUSTER_SERVER", "")
	t.Setenv("FLEET_CLUSTER_CA_FILE", "")
	t.Setenv("FLEET_CLUSTER_TOKEN_FILE", "")
	if c, err := loadCluster(); c != nil || err != nil {
		t.Fatalf("none set: %v %v", c, err)
	}
	t.Setenv("FLEET_CLUSTER_TOKEN_FILE", token)
	if _, err := loadCluster(); err == nil {
		t.Fatal("a token without a server and CA loaded")
	}
}
