package fleet

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// JoinGroup is the group a worker's bootstrap token authenticates in. Talos's
// bootstrap manifests bind it to system:node-bootstrapper and to the
// controller manager's approval of kubelet client CSRs, so a kubelet with the
// token can request its first client certificate and nothing else.
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
	base := "/api/v1/namespaces/" + joinTokenNamespace + "/secrets"
	err := c.do(ctx, http.MethodPost, base, "application/json", s, nil)
	if errors.Is(err, ErrConflict) {
		if err = c.do(ctx, http.MethodDelete, base+"/"+name, "", nil, nil); err == nil || errors.Is(err, ErrNotFound) {
			err = c.do(ctx, http.MethodPost, base, "application/json", s, nil)
		}
	}
	if err != nil {
		return "", fmt.Errorf("bootstrap token %s: %w", name, err)
	}
	return id + "." + secret, nil
}
