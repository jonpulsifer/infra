package fleetboot

import (
	"bufio"
	"bytes"
	"strings"
)

// mountpointIn says whether a mountinfo table, /proc/self/mountinfo's
// format, mounts a file system at path. The mount point is the fifth field,
// with spaces escaped as \040.
func mountpointIn(mountinfo []byte, path string) bool {
	s := bufio.NewScanner(bytes.NewReader(mountinfo))
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) >= 5 && strings.ReplaceAll(f[4], `\040`, " ") == path {
			return true
		}
	}
	return false
}
