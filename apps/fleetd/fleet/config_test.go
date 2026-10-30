package fleet

import (
	"os"
	"path/filepath"
	"testing"
)

// The cluster's credentials come all together or not at all: a half-set
// environment is a mistake, not a choice to skip the cordon.
func TestLoadClusterNeedsAllThree(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	_ = os.WriteFile(token, []byte("t\n"), 0o600)
	t.Setenv("FLEET_CLUSTER_SERVER", "")
	t.Setenv("FLEET_CLUSTER_CA_FILE", "")
	t.Setenv("FLEET_CLUSTER_TOKEN_FILE", "")
	if c, err := LoadCluster(); c != nil || err != nil {
		t.Fatalf("none set: %v %v", c, err)
	}
	t.Setenv("FLEET_CLUSTER_TOKEN_FILE", token)
	if _, err := LoadCluster(); err == nil {
		t.Fatal("a token without a server and CA loaded")
	}
}
