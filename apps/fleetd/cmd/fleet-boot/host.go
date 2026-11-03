package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/syslog"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// cmdlineValue is the value of the key=value word on a kernel command line.
func cmdlineValue(cmdline, key string) string {
	for _, word := range strings.Fields(cmdline) {
		if v, ok := strings.CutPrefix(word, key+"="); ok {
			return v
		}
	}
	return ""
}

// logger writes each line to stdout, which the journal keeps, to the
// consoles, where the owner watches the machine, and to the lab's syslog
// receiver when the command line names one.
type logger struct {
	mu     sync.Mutex
	syslog *syslog.Writer
}

func newLogger(host string) *logger {
	l := &logger{}
	if host != "" {
		if w, err := syslog.Dial("udp", net.JoinHostPort(host, "514"), syslog.LOG_NOTICE|syslog.LOG_DAEMON, "fleet-boot"); err == nil {
			l.syslog = w
		}
	}
	return l
}

func (l *logger) Printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	l.mu.Lock()
	defer l.mu.Unlock()
	os.Stdout.WriteString("fleet-boot: " + line + "\n")
	for _, tty := range []string{"/dev/tty0", "/dev/ttyS0"} {
		if f, err := os.OpenFile(tty, os.O_WRONLY, 0); err == nil {
			f.WriteString("fleet-boot: " + line + "\n")
			f.Close()
		}
	}
	if l.syslog != nil {
		_ = l.syslog.Notice(line)
	}
}

// defaultRouteInterface is the interface of the IPv4 default route in a
// /proc/net/route table: the NIC that netbooted holds it.
func defaultRouteInterface(r io.Reader) string {
	s := bufio.NewScanner(r)
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) < 4 || f[1] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err == nil && flags&0x1 != 0 {
			return f[0]
		}
	}
	return ""
}

// bootMAC waits for the default route and answers its NIC's MAC.
func bootMAC(wait time.Duration) (string, error) {
	deadline := time.Now().Add(wait)
	for {
		if f, err := os.Open("/proc/net/route"); err == nil {
			ifname := defaultRouteInterface(f)
			f.Close()
			if ifname != "" {
				if b, err := os.ReadFile("/sys/class/net/" + ifname + "/address"); err == nil {
					return strings.TrimSpace(string(b)), nil
				}
			}
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("no default route after %s", wait)
		}
		time.Sleep(2 * time.Second)
	}
}

// ntpEpoch is 1900-01-01, where NTP's seconds count from.
var ntpEpoch = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

func ntpTime(b []byte) time.Time {
	secs := binary.BigEndian.Uint32(b[0:4])
	frac := binary.BigEndian.Uint32(b[4:8])
	return ntpEpoch.Add(time.Duration(secs)*time.Second + time.Duration(uint64(frac)*uint64(time.Second)>>32))
}

// sntpOffset reads an SNTP server's answer to a request sent at t1 and
// received at t4 (RFC 4330): how far the local clock is behind the
// server's.
func sntpOffset(resp []byte, t1, t4 time.Time) (time.Duration, error) {
	if len(resp) < 48 {
		return 0, fmt.Errorf("a %d-byte answer is no NTP packet", len(resp))
	}
	if mode := resp[0] & 0x7; mode != 4 {
		return 0, fmt.Errorf("the answer is mode %d, not a server's", mode)
	}
	if li := resp[0] >> 6; li == 3 {
		return 0, errors.New("the server's clock is not synchronized")
	}
	if stratum := resp[1]; stratum == 0 || stratum > 15 {
		return 0, fmt.Errorf("the server is at stratum %d", stratum)
	}
	receive, transmit := ntpTime(resp[32:40]), ntpTime(resp[40:48])
	return (receive.Sub(t1) + transmit.Sub(t4)) / 2, nil
}

// setClock steps the clock to the NTP server's, which fleetd checks
// certificate dates against, and writes it to the RTC.
func setClock(server string, log *logger) {
	if server == "" {
		log.Printf("no fleet_ntp_server; the clock stays %s", time.Now().UTC().Format(time.RFC3339))
		return
	}
	offset, err := func() (time.Duration, error) {
		conn, err := net.DialTimeout("udp", net.JoinHostPort(server, "123"), 10*time.Second)
		if err != nil {
			return 0, err
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		req := make([]byte, 48)
		req[0] = 0x23
		t1 := time.Now()
		if _, err := conn.Write(req); err != nil {
			return 0, err
		}
		resp := make([]byte, 48)
		n, err := conn.Read(resp)
		t4 := time.Now()
		if err != nil {
			return 0, err
		}
		return sntpOffset(resp[:n], t1, t4)
	}()
	if err != nil {
		log.Printf("%s did not set the clock (%v); it stays %s", server, err, time.Now().UTC().Format(time.RFC3339))
		return
	}
	tv := syscall.NsecToTimeval(time.Now().Add(offset).UnixNano())
	if err := syscall.Settimeofday(&tv); err != nil {
		log.Printf("the clock refused the step from %s: %v", server, err)
		return
	}
	if out, err := exec.Command("hwclock", "--systohc", "--utc").CombinedOutput(); err != nil {
		log.Printf("the RTC refused the write: %v %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("clock set from %s: %s", server, time.Now().UTC().Format(time.RFC3339))
}

// mountSecurityfs mounts securityfs, where the kernel publishes the TCG event
// log, unless it is there.
func mountSecurityfs() error {
	if _, err := os.Stat("/sys/kernel/security/tpm0"); err == nil {
		return nil
	}
	err := syscall.Mount("securityfs", "/sys/kernel/security", "securityfs", 0, "")
	if errors.Is(err, syscall.EBUSY) {
		return nil
	}
	return err
}
