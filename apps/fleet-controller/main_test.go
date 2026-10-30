package main

import "testing"

// Without the prep station's port the controller would treat it as a rack
// port, so it refuses to start rather than run with none.
func TestLoadConfigRequiresTheIntakePort(t *testing.T) {
	for _, k := range []string{"FLEET_HOOKOS_URL", "FLEET_HOOKOS_CMDLINE", "FLEET_ATTEST_URL", "FLEET_NTP_SERVER"} {
		t.Setenv(k, "x")
	}
	for v, ok := range map[string]bool{"": false, "0": false, "-1": false, "65536": false, "port24": false, "24": true} {
		t.Setenv("FLEET_INTAKE_PORT", v)
		c, err := loadConfig()
		if (err == nil) != ok || ok && c.IntakePort != 24 {
			t.Errorf("FLEET_INTAKE_PORT=%q: port %d, err %v", v, c.IntakePort, err)
		}
	}
}
