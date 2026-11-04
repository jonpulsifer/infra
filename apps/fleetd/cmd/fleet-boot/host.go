package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log/syslog"
	"net"
	"os"
	"os/exec"
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
// receiver when the command line names one. The receiver is dialed on a
// line, at most every redial, until a dial succeeds: the first lines come
// before DHCP has given the machine a route.
type logger struct {
	mu     sync.Mutex
	host   string
	syslog *syslog.Writer
	tried  time.Time
	dial   func(addr string) (*syslog.Writer, error)
}

const redial = 5 * time.Second

func newLogger(host string) *logger {
	return &logger{host: host, dial: func(addr string) (*syslog.Writer, error) {
		return syslog.Dial("udp", addr, syslog.LOG_NOTICE|syslog.LOG_DAEMON, "fleet-boot")
	}}
}

// receiver is the syslog writer, dialed now when it is due.
func (l *logger) receiver(now time.Time) *syslog.Writer {
	if l.syslog == nil && l.host != "" && now.Sub(l.tried) >= redial {
		l.tried = now
		if w, err := l.dial(net.JoinHostPort(l.host, "514")); err == nil {
			l.syslog = w
		}
	}
	return l.syslog
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
	if w := l.receiver(time.Now()); w != nil {
		_ = w.Notice(line)
	}
}

// ntpEpoch is 1900-01-01, where NTP's seconds count from.
var ntpEpoch = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

// clockFloor is no earlier than this fleet-boot's build: an answer that
// would set the clock before it is refused, so a forged one cannot turn the
// clock back to where a revoked certificate still validates.
var clockFloor = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

func ntpTime(b []byte) time.Time {
	secs := binary.BigEndian.Uint32(b[0:4])
	frac := binary.BigEndian.Uint32(b[4:8])
	return ntpEpoch.Add(time.Duration(secs)*time.Second + time.Duration(uint64(frac)*uint64(time.Second)>>32))
}

// sntpOffset reads an SNTP server's answer to a request whose transmit
// timestamp was origin, sent at t1 and received at t4 (RFC 4330): how far the
// local clock is behind the server's. The answer must echo origin as its
// originate timestamp (section 5), and must not set the clock before
// clockFloor.
func sntpOffset(resp, origin []byte, t1, t4 time.Time) (time.Duration, error) {
	if len(resp) < 48 {
		return 0, fmt.Errorf("a %d-byte answer is no NTP packet", len(resp))
	}
	if !bytes.Equal(resp[24:32], origin) {
		return 0, errors.New("the answer does not echo the request's transmit timestamp")
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
	offset := (receive.Sub(t1) + transmit.Sub(t4)) / 2
	if t4.Add(offset).Before(clockFloor) {
		return 0, fmt.Errorf("the answer sets the clock to %s, before %s", t4.Add(offset).UTC().Format(time.RFC3339), clockFloor.Format(time.RFC3339))
	}
	return offset, nil
}

// setClock steps the clock to the NTP server's, which fleetd checks
// certificate dates against, and writes it to the RTC. The socket is
// connected, so the kernel passes it answers from the server's address
// alone, and the request's transmit timestamp is random, which only an
// answer to it echoes.
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
		if _, err := rand.Read(req[40:48]); err != nil {
			return 0, err
		}
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
		return sntpOffset(resp[:n], req[40:48], t1, t4)
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

// tmpfsMagic is statfs's f_type of a tmpfs.
const tmpfsMagic = 0x01021994

// mountRAM mounts a tmpfs of most of the machine's memory at dir, for the
// image download and the seed mounts, unless one is there, and answers its
// free bytes. Linux stacks a second tmpfs on the first rather than refuse
// it, so the check comes first.
func mountRAM(dir string) (int64, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, err
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	if st.Type != tmpfsMagic {
		if err := syscall.Mount("tmpfs", dir, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "mode=0700,size=80%"); err != nil {
			return 0, err
		}
		if err := syscall.Statfs(dir, &st); err != nil {
			return 0, err
		}
	}
	return int64(st.Bavail) * st.Bsize, nil
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
