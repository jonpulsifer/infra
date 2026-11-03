package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// WorkflowStore keeps fleetd's runs as Workflow objects. Tinkerbell's API
// is one, through Kube's own calls; Attempts, fleet-boot's records, is the
// other. With Kube.Workflows set, every Workflow call Kube takes goes there,
// so the Reconciler, the Installer and the BMC work read a run the same way
// under either executor.
type WorkflowStore interface {
	Get(ctx context.Context, name string) (Object, error)
	List(ctx context.Context, selector string) ([]Object, error)
	Create(ctx context.Context, wf Object) error
	Annotate(ctx context.Context, name string, annotations map[string]string) error
	DeleteUnchanged(ctx context.Context, name, resourceVersion string) error
	Delete(ctx context.Context, name string) error
}

// Step states, as Tinkerbell writes an action's.
const (
	stateRunning = "STATE_RUNNING"
	stateSuccess = "STATE_SUCCESS"
	stateFailed  = "STATE_FAILED"
	stateTimeout = "STATE_TIMEOUT"
)

// AttemptStep is one step of an attempt as fleet-boot reported it.
type AttemptStep struct {
	Name      string    `json:"name"`
	State     string    `json:"state"`
	Message   string    `json:"message,omitempty"`
	StartedAt time.Time `json:"started_at,omitzero"`
	EndedAt   time.Time `json:"ended_at,omitzero"`
}

// Attempt is one run under the boot executor: the Workflow fleetd would have
// created, and what fleet-boot reported of it.
type Attempt struct {
	Name        string            `json:"name"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	// Spec is the Workflow's spec, whose hardwareMap holds the run's inputs.
	Spec     map[string]any `json:"spec,omitempty"`
	Created  time.Time      `json:"created"`
	Revision uint64         `json:"revision"`
	// State is "" until fleet-boot asks for the run, then running, and at
	// the end success, failed or timeout.
	State      string        `json:"state,omitempty"`
	Steps      []AttemptStep `json:"steps,omitempty"`
	FailedStep string        `json:"failed_step,omitempty"`
	StartedAt  time.Time     `json:"started_at,omitzero"`
	EndedAt    time.Time     `json:"ended_at,omitzero"`
	// The session fleet-boot's requests go over, bound at the signed
	// confirm of the machine's intake pass: its ID, the AK's PKIX DER, the
	// nonce and the last sequence number taken. An attempt's end clears it,
	// so the session's later requests find no run.
	Session string `json:"session,omitempty"`
	AK      []byte `json:"ak,omitempty"`
	Nonce   []byte `json:"nonce,omitempty"`
	Seq     uint64 `json:"seq,omitempty"`
}

func (a *Attempt) finished() bool { return Finished(a.State) }

// end ends the attempt in state and drops its session.
func (a *Attempt) end(state string, at time.Time) {
	a.State, a.EndedAt = state, at
	a.Session, a.AK, a.Nonce = "", nil, nil
}

func anyMap(m map[string]string) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// object renders the attempt in a Workflow's shape: the fields the
// Reconciler reads of one.
func (a *Attempt) object() Object {
	status := map[string]any{
		"executor":      fleetBootExecutor,
		"state":         a.State,
		"globalTimeout": float64(TemplateGlobalTimeout / time.Second),
	}
	if !a.StartedAt.IsZero() {
		status["globalExecutionStop"] = a.StartedAt.Add(TemplateGlobalTimeout).UTC().Format(time.RFC3339)
	}
	var actions []any
	for _, s := range a.Steps {
		actions = append(actions, map[string]any{"name": s.Name, "state": s.State, "message": s.Message})
	}
	if n := len(a.Steps); n > 0 {
		status["currentState"] = map[string]any{"actionName": a.Steps[n-1].Name, "state": a.Steps[n-1].State}
	}
	status["tasks"] = []any{map[string]any{"name": "provision", "actions": actions}}
	// The callers may change what they read, so the spec's maps are
	// copies; their values are strings.
	s := maps.Clone(a.Spec)
	for k, v := range s {
		if m, ok := v.(map[string]any); ok {
			s[k] = maps.Clone(m)
		}
	}
	return Object{
		"apiVersion": WorkflowResource.apiVersion(),
		"kind":       WorkflowResource.Kind,
		"metadata": map[string]any{
			"name":              a.Name,
			"labels":            anyMap(a.Labels),
			"annotations":       anyMap(a.Annotations),
			"creationTimestamp": a.Created.UTC().Format(time.RFC3339),
			"resourceVersion":   strconv.FormatUint(a.Revision, 10),
		},
		"spec":   s,
		"status": status,
	}
}

// Attempts keeps every attempt in one JSON file in fleetd's state
// directory, written beside itself and renamed, so a restart reads the whole
// record or the one before.
type Attempts struct {
	File string
	Now  func() time.Time

	mu     sync.Mutex
	recs   map[string]*Attempt
	loaded bool
}

func (s *Attempts) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Attempts) load() error {
	if s.loaded {
		return nil
	}
	s.recs = map[string]*Attempt{}
	b, err := os.ReadFile(s.File)
	if errors.Is(err, os.ErrNotExist) {
		s.loaded = true
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &s.recs); err != nil {
		// A record fleetd cannot read would stop every run; it moves
		// aside, whole, for the owner, and the store starts empty.
		aside := fmt.Sprintf("%s.unreadable-%d", s.File, s.now().Unix())
		if rerr := os.Rename(s.File, aside); rerr != nil {
			return fmt.Errorf("%s does not parse (%v), and it cannot be moved aside: %w", s.File, err, rerr)
		}
		log.Printf("attempts: %s does not parse (%v); it is now %s, and fleetd starts with no attempts. Runs in it are lost: set desired_action again for any that had not finished", s.File, err, aside)
		s.recs = map[string]*Attempt{}
	}
	s.loaded = true
	return nil
}

func (s *Attempts) save() error {
	b, err := json.MarshalIndent(s.recs, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(s.File), "."+filepath.Base(s.File)+".tmp")
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.File)
}

// update loads the store, runs fn on the named attempt under the lock, and
// saves when fn changed it.
func (s *Attempts) update(name string, fn func(a *Attempt) (bool, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	a, ok := s.recs[name]
	if !ok {
		return ErrNotFound
	}
	changed, err := fn(a)
	if changed {
		a.Revision++
		if serr := s.save(); serr != nil {
			return serr
		}
	}
	return err
}

func (s *Attempts) Get(_ context.Context, name string) (Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return nil, err
	}
	a, ok := s.recs[name]
	if !ok {
		return nil, ErrNotFound
	}
	return a.object(), nil
}

// selects says whether labels satisfy an equality selector, k=v,k=v.
func selects(labels map[string]string, selector string) bool {
	for _, term := range strings.Split(selector, ",") {
		if term == "" {
			continue
		}
		k, v, _ := strings.Cut(term, "=")
		if labels[k] != v {
			return false
		}
	}
	return true
}

func (s *Attempts) List(_ context.Context, selector string) ([]Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(s.recs))
	for n := range s.recs {
		names = append(names, n)
	}
	sort.Strings(names)
	var out []Object
	for _, n := range names {
		if a := s.recs[n]; selects(a.Labels, selector) {
			out = append(out, a.object())
		}
	}
	return out, nil
}

func (s *Attempts) Create(_ context.Context, wf Object) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	name := wf.Name()
	if name == "" {
		return errors.New("an attempt needs a name")
	}
	if _, ok := s.recs[name]; ok {
		return fmt.Errorf("attempt %s: %w", name, ErrConflict)
	}
	spec, _ := wf["spec"].(map[string]any)
	s.recs[name] = &Attempt{Name: name, Labels: wf.Labels(), Annotations: wf.Annotations(), Spec: spec, Created: s.now(), Revision: 1}
	return s.save()
}

// Annotate merges annotations. OverdueAnnotation is fleetd asking
// Tinkerbell's controller to end an overdue run; here the store is that
// controller, and the attempt ends as TIMEOUT.
func (s *Attempts) Annotate(_ context.Context, name string, annotations map[string]string) error {
	return s.update(name, func(a *Attempt) (bool, error) {
		if a.Annotations == nil {
			a.Annotations = map[string]string{}
		}
		for k, v := range annotations {
			a.Annotations[k] = v
		}
		if _, ok := annotations[OverdueAnnotation]; ok && !a.finished() && !a.StartedAt.IsZero() {
			a.end(stateTimeout, s.now())
			if n := len(a.Steps); n > 0 && a.Steps[n-1].State == stateRunning {
				a.Steps[n-1].State, a.Steps[n-1].EndedAt = stateTimeout, a.EndedAt
				a.FailedStep = a.Steps[n-1].Name
			}
		}
		return true, nil
	})
}

func (s *Attempts) DeleteUnchanged(_ context.Context, name, resourceVersion string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	a, ok := s.recs[name]
	if !ok {
		return nil
	}
	if strconv.FormatUint(a.Revision, 10) != resourceVersion {
		return fmt.Errorf("attempt %s changed: %w", name, ErrConflict)
	}
	delete(s.recs, name)
	return s.save()
}

func (s *Attempts) Delete(_ context.Context, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	if _, ok := s.recs[name]; !ok {
		return nil
	}
	delete(s.recs, name)
	return s.save()
}

// BootSession is a passed intake session after its signed confirm, which
// the verifier hands over: fleet-boot's later requests are checked against
// its AK and nonce.
type BootSession struct {
	ID    string
	Node  string
	AK    []byte
	Nonce []byte
}

// Bind gives the node's unfinished attempt the session, and answers its
// name, or "" when it binds none. An attempt that already started ran in
// an earlier boot, and a run never resumes in a new one: it fails with that
// reason, as the Templates' runs do, and the recovery is a new request.
func (s *Attempts) Bind(bs BootSession) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return "", err
	}
	var newest *Attempt
	for _, a := range s.recs {
		if a.Labels[NodeLabel] != bs.Node || a.finished() {
			continue
		}
		if newest == nil || a.Created.After(newest.Created) {
			newest = a
		}
	}
	if newest == nil {
		return "", nil
	}
	now := s.now()
	if !newest.StartedAt.IsZero() {
		last := "the run request"
		if n := len(newest.Steps); n > 0 {
			last = newest.Steps[n-1].Name
		}
		newest.end(stateFailed, now)
		newest.FailedStep = last
		newest.Steps = append(newest.Steps, AttemptStep{Name: last, State: stateFailed, Message: "the machine booted fleet-boot again after " + last + "; a run never resumes in a new boot; set desired_action to run it again", StartedAt: now, EndedAt: now})
		newest.Revision++
		return "", s.save()
	}
	newest.Session, newest.AK, newest.Nonce, newest.Seq = bs.ID, bs.AK, bs.Nonce, 0
	newest.Revision++
	return newest.Name, s.save()
}

// errStale is a request whose sequence number fleetd took already, or one
// over an attempt that ended; errBadReport is a report no run takes.
var (
	errStale     = errors.New("stale")
	errBadReport = errors.New("bad report")
)

// take finds the attempt bound to the session, checks the request's number
// and signature with check, and records the number. It answers a copy.
func (s *Attempts) take(session string, seq uint64, check func(a *Attempt) error) (Attempt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return Attempt{}, err
	}
	for _, a := range s.recs {
		if a.Session != session || session == "" {
			continue
		}
		if err := check(a); err != nil {
			return Attempt{}, err
		}
		if seq <= a.Seq {
			return Attempt{}, fmt.Errorf("%w: request %d, and fleetd took %d", errStale, seq, a.Seq)
		}
		a.Seq = seq
		a.Revision++
		return *a, s.save()
	}
	return Attempt{}, ErrNotFound
}

// started marks the attempt running from its first run request.
func (s *Attempts) started(name string) error {
	return s.update(name, func(a *Attempt) (bool, error) {
		if a.finished() {
			return false, fmt.Errorf("%w: %s ended %s", errStale, a.Name, a.State)
		}
		if !a.StartedAt.IsZero() {
			return false, nil
		}
		a.State, a.StartedAt = stateRunning, s.now()
		return true, nil
	})
}

// report applies a step's report: a start opens the step, a success closes
// it and, for the reboot, ends the run, and a failure ends the run there.
func (s *Attempts) report(name string, r protocol.BootReport) error {
	return s.update(name, func(a *Attempt) (bool, error) {
		if a.finished() || a.StartedAt.IsZero() {
			return false, fmt.Errorf("%w: %s is %q", errStale, a.Name, a.State)
		}
		now := s.now()
		last := len(a.Steps) - 1
		switch r.Phase {
		case protocol.PhaseStarted:
			if last >= 0 && a.Steps[last].State == stateRunning {
				return false, fmt.Errorf("%w: %s starts while %s runs", errBadReport, r.Step, a.Steps[last].Name)
			}
			a.Steps = append(a.Steps, AttemptStep{Name: r.Step, State: stateRunning, StartedAt: now})
		case protocol.PhaseSucceeded, protocol.PhaseFailed:
			if last < 0 || a.Steps[last].Name != r.Step || a.Steps[last].State != stateRunning {
				// fleet-boot fails a run before its first step starts when
				// the run's inputs are refused.
				if r.Phase != protocol.PhaseFailed {
					return false, fmt.Errorf("%w: %s ends without its start", errBadReport, r.Step)
				}
				a.Steps = append(a.Steps, AttemptStep{Name: r.Step, StartedAt: now})
				last = len(a.Steps) - 1
			}
			st := &a.Steps[last]
			st.Message, st.EndedAt = r.Detail, now
			if r.Phase == protocol.PhaseFailed {
				st.State = stateFailed
				a.end(stateFailed, now)
				a.FailedStep = r.Step
			} else {
				st.State = stateSuccess
				if r.Step == protocol.StepReboot {
					a.end(stateSuccess, now)
				}
			}
		default:
			return false, fmt.Errorf("%w: phase %q", errBadReport, r.Phase)
		}
		return true, nil
	})
}

// fleetBootExecutor marks a run fleet-boot runs, in status.executor, so the
// journal names fleet-boot and its log for it.
const fleetBootExecutor = "fleet-boot"

func ranByFleetBoot(wf Object) bool {
	st, _ := wf["status"].(map[string]any)
	s, _ := st["executor"].(string)
	return s == fleetBootExecutor
}

// executorName is what runs the run, and bootImage the image it runs in.
func executorName(wf Object) string {
	if ranByFleetBoot(wf) {
		return "fleet-boot"
	}
	return "Tinkerbell"
}

func bootImage(wf Object) string {
	if ranByFleetBoot(wf) {
		return "fleet-boot"
	}
	return "HookOS"
}

// endedBy says how fleetd ended an overdue run: Tinkerbell's controller ends
// a Workflow once asked; fleetd ends an attempt itself.
func endedBy(wf Object) string {
	if ranByFleetBoot(wf) {
		return "ended it"
	}
	return "asked Tinkerbell to end it"
}

// firstReportLost is what stops a run before its first report.
func firstReportLost(wf Object) string {
	if ranByFleetBoot(wf) {
		return "a fleet-boot that stopped before it asked for the run"
	}
	return "an agent that died before wipe-disk reported"
}

// consoleHint says where a failed run's machine-side log is: spore's
// tinkerbell journal for HookOS, and for fleet-boot, which reports its
// reason with the step, its syslog lines in spore's journal.
func consoleHint(wf Object, d Device) string {
	if ranByFleetBoot(wf) {
		return fmt.Sprintf(". fleet-boot's log is in spore's journal: journalctl -t hookos HOOKOS_PROGRAM=fleet-boot | grep %s", d.Address)
	}
	return fmt.Sprintf(". The reason is in the machine's console output, which spore's tinkerbell journal holds: journalctl -u tinkerbell | grep %s", d.Address)
}
