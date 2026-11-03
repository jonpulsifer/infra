// Package bmc drives a machine's power and its next boot through its
// baseboard management controller. fleetd uses it in its native BMC mode,
// where it does what Rufio's Machine and Job objects do otherwise.
package bmc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/bmc-toolbox/bmclib/v2/providers/intelamt"
)

// The power states a BMC reports.
const (
	On  = "on"
	Off = "off"
)

// BMC is one machine's controller.
type BMC interface {
	// Power reads the machine's power state, On or Off.
	Power(ctx context.Context) (string, error)
	// PowerOff turns the machine off, and does nothing to a machine that is
	// off. It returns once the BMC takes the request, which may be before
	// the machine is off.
	PowerOff(ctx context.Context) error
	// PowerOn turns the machine on, and does nothing to a machine that is on.
	PowerOn(ctx context.Context) error
	// PXEOnce makes the machine's next boot, and only that one, a network
	// boot.
	PXEOnce(ctx context.Context) error
}

// Credential is the user and password a BMC type takes.
type Credential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoadCredential reads a credential file: one JSON object with username and
// password, both set.
func LoadCredential(path string) (Credential, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Credential{}, err
	}
	var c Credential
	if err := json.Unmarshal(b, &c); err != nil {
		return Credential{}, fmt.Errorf("%s is not a JSON object with username and password", path)
	}
	if c.Username == "" || c.Password == "" {
		return Credential{}, fmt.Errorf("%s needs both username and password", path)
	}
	return c, nil
}

// Dialer opens the BMC of a type at an address with that type's credential,
// and keeps one client per address.
type Dialer struct {
	Credentials map[string]Credential
	// AMTPort is AMT's plain-HTTP WS-Management port.
	AMTPort int
	// Timeout bounds each call to a BMC.
	Timeout time.Duration

	mu   sync.Mutex
	open map[string]BMC
}

// Dial opens the BMC of bmcType at host.
func (d *Dialer) Dial(bmcType, host string) (BMC, error) {
	if host == "" {
		return nil, errors.New("the BMC has no address")
	}
	cred, ok := d.Credentials[bmcType]
	if !ok {
		return nil, fmt.Errorf("no credential is configured for bmc_type %q", bmcType)
	}
	key := bmcType + "/" + host
	d.mu.Lock()
	defer d.mu.Unlock()
	if b, ok := d.open[key]; ok {
		return b, nil
	}
	var b BMC
	switch bmcType {
	case "amt":
		b = NewAMT(host, d.AMTPort, cred, d.Timeout)
	default:
		return nil, fmt.Errorf("bmc_type %q has no native driver", bmcType)
	}
	if d.open == nil {
		d.open = map[string]BMC{}
	}
	d.open[key] = b
	return b, nil
}

// AMT is Intel AMT over WS-Management, through bmclib's Intel AMT provider.
// It speaks plain HTTP with digest auth, because AMT's TLS offers only RSA
// key exchange, which Go refuses.
type AMT struct {
	conn    *intelamt.Conn
	timeout time.Duration
	mu      sync.Mutex
}

// NewAMT is the AMT at host on port. A timeout of zero or less is 30
// seconds.
func NewAMT(host string, port int, cred Credential, timeout time.Duration) *AMT {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &AMT{
		conn:    intelamt.New(host, cred.Username, cred.Password, intelamt.WithHostScheme("http"), intelamt.WithPort(uint32(port))),
		timeout: timeout,
	}
}

// do runs one call on a fresh digest challenge. The client holds the
// challenge, so calls take turns.
func (a *AMT) do(ctx context.Context, f func(context.Context) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()
	if err := a.conn.Open(ctx); err != nil {
		return oneLine(err)
	}
	defer a.conn.Close(ctx)
	return oneLine(f(ctx))
}

func (a *AMT) Power(ctx context.Context) (string, error) {
	var state string
	err := a.do(ctx, func(ctx context.Context) error {
		var err error
		state, err = a.conn.PowerStateGet(ctx)
		return err
	})
	return state, err
}

// PowerOff requests the first power-off state the BMC offers, of graceful
// soft off, soft off, graceful hard off and hard off, as Rufio's power-off
// does through the same provider.
func (a *AMT) PowerOff(ctx context.Context) error { return a.set(ctx, Off) }

func (a *AMT) PowerOn(ctx context.Context) error { return a.set(ctx, On) }

// set reads the power state before it asks for state, because the
// provider's PowerSet takes a failed read for "off" and then sends no
// power-off at all.
func (a *AMT) set(ctx context.Context, state string) error {
	return a.do(ctx, func(ctx context.Context) error {
		if _, err := a.conn.PowerStateGet(ctx); err != nil {
			return fmt.Errorf("read the power state: %w", err)
		}
		_, err := a.conn.PowerSet(ctx, state)
		return err
	})
}

// PXEOnce sets AMT's boot configuration role to next single use with the
// Force PXE Boot source, as Rufio's one-time boot device task does.
func (a *AMT) PXEOnce(ctx context.Context) error {
	return a.do(ctx, func(ctx context.Context) error {
		_, err := a.conn.BootDeviceSet(ctx, "pxe", false, true)
		return err
	})
}

// oneLine joins an error's lines, since bmclib's span several and the
// journal takes one.
func oneLine(err error) error {
	if err == nil {
		return nil
	}
	return lineError{err}
}

// lineError is an error on one line that still unwraps to the original.
type lineError struct{ err error }

func (e lineError) Error() string { return strings.Join(strings.Fields(e.err.Error()), " ") }

func (e lineError) Unwrap() error { return e.err }
