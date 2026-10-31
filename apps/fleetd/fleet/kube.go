package fleet

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// FieldManager names fleetd's server-side-apply ownership, and is the
// ManagedLabel value the objects it owns carry. It keeps the name the objects
// on Tinkerbell's API were made under.
const FieldManager = "fleet-controller"

// ManagedLabel marks every object fleetd creates.
const ManagedLabel = "lolwtf.ca/managed-by"

// Kube is a client for the few resources fleetd owns on Tinkerbell's
// kube-apiserver. A client-go dependency would be most of the binary.
type Kube struct {
	Server    string
	Namespace string
	Client    *http.Client
}

// Resource names a namespaced custom resource.
type Resource struct {
	Group, Version, Plural, Kind string
}

var (
	HardwareResource = Resource{"tinkerbell.org", "v1alpha1", "hardware", "Hardware"}
	WorkflowResource = Resource{"tinkerbell.org", "v1alpha1", "workflows", "Workflow"}
	MachineResource  = Resource{"bmc.tinkerbell.org", "v1alpha1", "machines", "Machine"}
)

func (r Resource) apiVersion() string { return r.Group + "/" + r.Version }

// ErrNotFound is a 404 from the API.
var ErrNotFound = errors.New("not found")

// ErrConflict is a 409 from the API, such as a failed delete precondition.
var ErrConflict = errors.New("409 Conflict")

// NewKube reads the CA and client certificate files.
func NewKube(server, caFile, certFile, keyFile, namespace string) (*Kube, error) {
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, fmt.Errorf("%s holds no certificate", caFile)
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &Kube{
		Server:    strings.TrimSuffix(server, "/"),
		Namespace: namespace,
		Client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{
				RootCAs:      pool,
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS12,
			}},
		},
	}, nil
}

func (k *Kube) path(r Resource, name string) string {
	p := fmt.Sprintf("/apis/%s/%s/namespaces/%s/%s", r.Group, r.Version, k.Namespace, r.Plural)
	if name != "" {
		p += "/" + name
	}
	return p
}

func (k *Kube) do(ctx context.Context, method, path, contentType string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, k.Server+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := k.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		status := errors.New(resp.Status)
		if resp.StatusCode == http.StatusConflict {
			status = ErrConflict
		}
		return fmt.Errorf("%s %s: %w: %s", method, path, status, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// Object is an unstructured Kubernetes object.
type Object map[string]any

func (o Object) metadata() map[string]any {
	m, _ := o["metadata"].(map[string]any)
	return m
}

// Name is metadata.name.
func (o Object) Name() string {
	s, _ := o.metadata()["name"].(string)
	return s
}

// Created is metadata.creationTimestamp.
func (o Object) Created() time.Time {
	s, _ := o.metadata()["creationTimestamp"].(string)
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// ResourceVersion is metadata.resourceVersion.
func (o Object) ResourceVersion() string {
	s, _ := o.metadata()["resourceVersion"].(string)
	return s
}

// Labels is metadata.labels.
func (o Object) Labels() map[string]string {
	out := map[string]string{}
	l, _ := o.metadata()["labels"].(map[string]any)
	for k, v := range l {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return out
}

// State is status.state, a Workflow's overall state.
func (o Object) State() string {
	st, _ := o["status"].(map[string]any)
	s, _ := st["state"].(string)
	return s
}

// GlobalExecutionStop is status.globalExecutionStop, the deadline Tinkerbell
// sets for a Workflow. It is false when the field is missing or unparseable.
func (o Object) GlobalExecutionStop() (time.Time, bool) {
	st, _ := o["status"].(map[string]any)
	s, _ := st["globalExecutionStop"].(string)
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil && !t.IsZero()
}

// GlobalTimeout is status.globalTimeout, the global timeout Tinkerbell's
// controller copies from the rendered Template. It is false when the field is
// missing or not positive, as before the controller's first reconcile.
func (o Object) GlobalTimeout() (time.Duration, bool) {
	st, _ := o["status"].(map[string]any)
	s, _ := st["globalTimeout"].(float64)
	return time.Duration(s) * time.Second, s > 0
}

// CurrentAction is status.currentState.actionName, the action a Workflow's
// agent last reported on.
func (o Object) CurrentAction() string {
	st, _ := o["status"].(map[string]any)
	cs, _ := st["currentState"].(map[string]any)
	s, _ := cs["actionName"].(string)
	return s
}

// FailedAction is the first action in status.tasks that ended FAILED or
// TIMEOUT, with its state and message. The name is empty when no action did.
func (o Object) FailedAction() (name, state, message string) {
	st, _ := o["status"].(map[string]any)
	tasks, _ := st["tasks"].([]any)
	for _, t := range tasks {
		task, _ := t.(map[string]any)
		actions, _ := task["actions"].([]any)
		for _, a := range actions {
			act, _ := a.(map[string]any)
			s, _ := act["state"].(string)
			s = strings.TrimPrefix(s, "STATE_")
			if s == "FAILED" || s == "TIMEOUT" {
				name, _ := act["name"].(string)
				message, _ := act["message"].(string)
				return name, s, message
			}
		}
	}
	return "", "", ""
}

// Annotate sets annotations on an existing object with a merge patch that
// carries metadata.annotations alone, so no other field and no other
// writer's annotation is touched. A missing object is ErrNotFound.
func (k *Kube) Annotate(ctx context.Context, r Resource, name string, annotations map[string]string) error {
	body, err := json.Marshal(map[string]any{"metadata": map[string]any{"annotations": annotations}})
	if err != nil {
		return err
	}
	q := url.Values{"fieldManager": {FieldManager}}
	return k.do(ctx, http.MethodPatch, k.path(r, name)+"?"+q.Encode(), "application/merge-patch+json", body, nil)
}

// Apply is a server-side apply that takes ownership of conflicting fields.
func (k *Kube) Apply(ctx context.Context, r Resource, obj Object) error {
	body, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	q := url.Values{"fieldManager": {FieldManager}, "force": {"true"}}
	return k.do(ctx, http.MethodPatch, k.path(r, obj.Name())+"?"+q.Encode(), "application/apply-patch+yaml", body, nil)
}

// Create posts a new object.
func (k *Kube) Create(ctx context.Context, r Resource, obj Object) error {
	body, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	q := url.Values{"fieldManager": {FieldManager}}
	return k.do(ctx, http.MethodPost, k.path(r, "")+"?"+q.Encode(), "application/json", body, nil)
}

// Get reads one object, or ErrNotFound.
func (k *Kube) Get(ctx context.Context, r Resource, name string) (Object, error) {
	var obj Object
	if err := k.do(ctx, http.MethodGet, k.path(r, name), "", nil, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// List reads the objects that match a label selector.
func (k *Kube) List(ctx context.Context, r Resource, selector string) ([]Object, error) {
	var list struct {
		Items []Object `json:"items"`
	}
	q := url.Values{}
	if selector != "" {
		q.Set("labelSelector", selector)
	}
	if err := k.do(ctx, http.MethodGet, k.path(r, "")+"?"+q.Encode(), "", nil, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

// DeleteUnchanged removes an object only while its resourceVersion is the one
// given, so a write since that read keeps it and answers ErrConflict. A
// missing object is no error.
func (k *Kube) DeleteUnchanged(ctx context.Context, r Resource, name, resourceVersion string) error {
	body, err := json.Marshal(map[string]any{
		"apiVersion":    "v1",
		"kind":          "DeleteOptions",
		"preconditions": map[string]any{"resourceVersion": resourceVersion},
	})
	if err != nil {
		return err
	}
	err = k.do(ctx, http.MethodDelete, k.path(r, name), "application/json", body, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// Delete removes an object; a missing one is no error.
func (k *Kube) Delete(ctx context.Context, r Resource, name string) error {
	err := k.do(ctx, http.MethodDelete, k.path(r, name), "", nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}
