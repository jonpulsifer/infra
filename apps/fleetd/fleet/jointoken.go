package fleet

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// JoinGroup is the group a worker's bootstrap token authenticates in. Talos's
// bootstrap manifests bind it to system:node-bootstrapper, so a kubelet with
// the token can request its first client certificate and nothing else. folly
// does not bind it to the controller manager's approval of that request:
// fleetd approves it only for the node the token was minted for
// (joincsr.go).
const JoinGroup = "system:bootstrappers:nodes"

// JoinTokenGrace is how long a worker's bootstrap token outlives its
// config's TTL. The node fetches its config within the TTL, and its kubelet
// bootstraps within minutes of that first boot. After the bootstrap the
// kubelet authenticates with its own client certificate, which it renews
// with that certificate, so the expired token stops nothing that runs.
const JoinTokenGrace = 4 * time.Hour

// JoinTokenMaxLifetime is the longest expiration the account's admission
// policy, fleet-controller-join-tokens, admits for a token: 8 hours from its
// creation. A config TTL plus JoinTokenGrace must fit in it.
const JoinTokenMaxLifetime = 8 * time.Hour

const joinTokenNamespace = "kube-system"

// joinLedgerFile is the JoinLedger's file in FLEET_CONFIG_DIR.
const joinLedgerFile = "join-tokens.json"

var joinTokenPattern = regexp.MustCompile(`^[a-z0-9]{6}\.[a-z0-9]{16}$`)

// JoinTokens creates the bootstrap token a worker's install config carries.
type JoinTokens interface {
	// Mint makes the node's token, valid until expires, in place of any
	// earlier one, and returns it as <id>.<secret>.
	Mint(ctx context.Context, node string, expires time.Time) (string, error)
}

// JoinTokenID is the node's bootstrap token ID: six characters of [a-z0-9]
// from a hash of its name. A node has one token Secret,
// bootstrap-token-<id>, so a new render replaces the token of the last one.
// The ID names the token and proves nothing; the secret half is random.
func JoinTokenID(node string) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	sum := sha256.Sum256([]byte("fleetd-join/" + node))
	id := make([]byte, 6)
	for i := range id {
		id[i] = alphabet[int(sum[i])%len(alphabet)]
	}
	return string(id)
}

func joinTokenSecretName(node string) string { return "bootstrap-token-" + JoinTokenID(node) }

// Mint creates the node's bootstrap token Secret in kube-system, or replaces
// the one an earlier render made by deleting it and creating it again, so the
// node has one live token and an older config's token stops working. The
// account's admission policy admits only this shape: named for its ID,
// labelled with fleetd and the node, authentication only, the one group, and
// an expiration within JoinTokenMaxLifetime of its creation. It admits no
// update, so it judges every token's expiration against the time the API
// server created it.
//
// The ledger keeps the token's ID, the API server's creation time and the
// expiration, which the approval of the node's kubelet client certificate
// checks: the account cannot read a Secret back.
func (c *Cluster) Mint(ctx context.Context, node string, expires time.Time) (string, error) {
	id := JoinTokenID(node)
	secret := strings.ToLower(rand.Text())[:16]
	name := joinTokenSecretName(node)
	s := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":      name,
			"namespace": joinTokenNamespace,
			"labels":    map[string]string{ManagedLabel: FieldManager, NodeLabel: node},
		},
		"type": "bootstrap.kubernetes.io/token",
		"stringData": map[string]string{
			"description":                    fmt.Sprintf("fleetd: %s's install config; it joins the node once", node),
			"token-id":                       id,
			"token-secret":                   secret,
			"expiration":                     expires.UTC().Format(time.RFC3339),
			"usage-bootstrap-authentication": "true",
			"auth-extra-groups":              JoinGroup,
		},
	}
	var created struct {
		Metadata struct {
			CreationTimestamp time.Time `json:"creationTimestamp"`
		} `json:"metadata"`
	}
	base := "/api/v1/namespaces/" + joinTokenNamespace + "/secrets"
	err := c.do(ctx, http.MethodPost, base, "application/json", s, &created)
	if errors.Is(err, ErrConflict) {
		if err = c.do(ctx, http.MethodDelete, base+"/"+name, "", nil, nil); err == nil || errors.Is(err, ErrNotFound) {
			err = c.do(ctx, http.MethodPost, base, "application/json", s, &created)
		}
	}
	if err != nil {
		return "", fmt.Errorf("bootstrap token %s: %w", name, err)
	}
	if err := c.Ledger.Put(node, JoinRecord{ID: id, Created: created.Metadata.CreationTimestamp, Expires: expires.UTC().Truncate(time.Second)}); err != nil {
		return "", fmt.Errorf("record bootstrap token %s: %w", name, err)
	}
	return id + "." + secret, nil
}

// JoinRecord is the bootstrap token fleetd minted for a node: its ID, when
// the API server created it, and when it expires.
type JoinRecord struct {
	ID      string    `json:"id"`
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"`
}

// JoinLedger holds each node's newest bootstrap token, by node name. With
// File set it is also kept there, mode 0600, in fleetd's tmpfs config
// directory, so an install in flight across a restart still has its
// certificate approved; a restart drops the records past their expiry. A
// nil ledger holds nothing and records nothing.
type JoinLedger struct {
	File string

	mu      sync.Mutex
	loaded  bool
	records map[string]JoinRecord
}

// load reads File once. The caller holds mu.
func (l *JoinLedger) load() error {
	if l.loaded {
		return nil
	}
	l.records = map[string]JoinRecord{}
	if l.File != "" {
		b, err := os.ReadFile(l.File)
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			return err
		default:
			if err := json.Unmarshal(b, &l.records); err != nil {
				return fmt.Errorf("%s: %w", l.File, err)
			}
		}
		now := time.Now()
		for node, r := range l.records {
			if !now.Before(r.Expires) {
				delete(l.records, node)
			}
		}
	}
	l.loaded = true
	return nil
}

// save writes File. The caller holds mu.
func (l *JoinLedger) save() error {
	if l.File == "" {
		return nil
	}
	b, err := json.Marshal(l.records)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.File), 0o700); err != nil {
		return err
	}
	return writeAtomic(l.File, b)
}

// Put records the node's token in place of its last one.
func (l *JoinLedger) Put(node string, r JoinRecord) error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.load(); err != nil {
		return err
	}
	l.records[node] = r
	return l.save()
}

// Get is the node's newest token.
func (l *JoinLedger) Get(node string) (JoinRecord, bool, error) {
	if l == nil {
		return JoinRecord{}, false, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.load(); err != nil {
		return JoinRecord{}, false, err
	}
	r, ok := l.records[node]
	return r, ok, nil
}

// Drop forgets the node's token, once it is spent or revoked.
func (l *JoinLedger) Drop(node string) error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.load(); err != nil {
		return err
	}
	if _, ok := l.records[node]; !ok {
		return nil
	}
	delete(l.records, node)
	return l.save()
}
