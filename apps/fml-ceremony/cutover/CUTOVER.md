# Re-birthing the FML Root and Intermediate

The ordered sequence for replacing the FML Root and Intermediate CA **keys**
with the ones the ceremony mints, across `folly` and `offsite`, without a
maintenance window.

Every step below is a named action in `model.go`. `TestRunbookPlanReplaysClean`
replays this list against the model and `TestCutoverDocMatchesTheCheckedPlan`
asserts this document still lists them in this order, so the runbook cannot
drift away from the thing that was checked. Run the model with
`mise run pki:cutover`.

## What makes this safe

The per-cluster Kubernetes CA **keys survive**. Only their certificates
reissue, under the new Intermediate. Every certificate `cfssl` has already
handed out names its issuer by the cluster CA's `subjectKeyIdentifier`, which is
derived from that surviving key and does not move. So the API server's serving
certificate verifies against the retiring anchors and the incoming ones alike,
and there is no moment at which a client has to have already switched.

That is the entire argument, and it is load-bearing:
`TestRotatingTheClusterCAKeyReintroducesTheWindow` shows this same sequence
locking `kubectl`, Flux and Prometheus out on the ninth step if the cluster CA
key is rotated in the same change. **Do not rotate the cluster CA keys here.**
That is a separate rotation with an overlap bundle and its own runbook.

What does change: `authorityKeyIdentifier` on both cluster CAs and both SA
signers, because it names the Intermediate. Nothing else beneath them moves.

## Before you start

- `mise run pki:cutover` and `mise run pki:verify` both pass on `main`.
- The ceremony transcript verifies and the new Intermediate private key is on
  the air-gapped host, ready to be published. The Root key never leaves it.
- You can reach `retrofit` and `optiplex`. `offsite` is behind Starlink; that is
  why it goes first.
- Nothing else is mid-flight in `terraform/pki`.

## The sequence

### 1. `ceremony: mint anchors (pathLen 2 / 1)`

Air-gapped. The Root must carry `pathLen >= 2` and the Intermediate
`pathLen >= 1`: two CAs follow the Root and one follows the Intermediate.

This is the fault nothing in the cluster reports. Go's `crypto/x509` treats
every certificate in a trust store as an anchor and stops there, so `kubectl`,
Flux, Prometheus and every smoke test stay green on anchors that forbid the
depth beneath them. Only full-path validators refuse — Vector, and Spindrift's
Node runtime. `mise run pki:verify` at step 7 is the only thing between that
mistake and the fleet.

### 2. `1password: preserve the superseded Intermediate item`

Copy the current `FML Intermediate CA` item to a new, versioned title before
anything overwrites it. The retiring Intermediate key signed everything now
deployed and there is no other copy of it.

Rollback must not depend on 1Password item history — the same rule
`terraform/pki/README.md` sets for the cluster CA escrow. **After step 3 this is
the only way back.**

### 3. `1password: publish the new ca.crt and ca.key`

    op://homelab/FML Root CA/ca.crt          <- the new root certificate
    op://homelab/FML Intermediate CA/ca.crt  <- the new intermediate certificate
    op://homelab/FML Intermediate CA/ca.key  <- the new intermediate key

`ca.crt` and `ca.key` on the Intermediate item are two separate fields. Set both
in one edit. A half-update signs the cluster CAs with one generation and
publishes the other; `pki:verify` catches it, but only at step 7.

This edit is not a git change, so nothing autoplans on it. From here until step
4 completes, any `atlantis apply` on `terraform/pki` — including one from an
unrelated PR — will replace the four leaf certificates. Do not leave this gap
open longer than the next step takes.

### 4. `atlantis: apply terraform/pki`

Open a PR touching `terraform/pki/*.tf` or comment `atlantis plan -d
terraform/pki`, then read the plan before applying.

It must replace **exactly four** `tls_locally_signed_cert` resources — both
cluster CAs and both SA signers — because their issuer certificate changed.
Every `tls_private_key` must show **no change**: a diff there marks the
1Password key escrow for replacement and its `prevent_destroy` fails the apply.

A successful apply automerges, so `main` now has the new terraform state and the
old `terraform/pki/certs`. That is a consistent, working estate — the committed
certificates still verify everything — but do not stop here.

### 5. `scripts/pki/post-rotate.sh folly`
### 6. `scripts/pki/post-rotate.sh offsite`

Run them together:

    nix develop -c bash scripts/pki/post-rotate.sh folly offsite

**Both clusters, one invocation.** The script rewrites `fml-root.pem` and
`fml-intermediate.pem` unconditionally but only the named cluster's CA and
chain, so running it for one cluster leaves the other's `-ca-chain.pem` pinned
to anchors that are no longer in the tree.
`TestPostRotateForOneClusterLeavesTheTreeIncoherent` is that state.

Then delete anything it wrote as `*-ca-prev.pem` or `*-sa-signer-prev.pem` and
rerun it. Those are overlap artifacts for a **key** rotation. This is not one:
the keys survive, so the previous certificates protect nothing, and a duplicate
signer certificate publishes the same JWKS `kid` twice.

### 7. `mise run pki:verify`

Must pass before anything is committed. This is the gate — see step 1.

### 8. `git: merge terraform/pki/certs to main`

Commit `terraform/pki/certs`, `terraform/pki/oidc`, `nix/secrets`, and
`clusters/offsite/apps/spindrift/ca-bundle.yaml` together, then merge.

**This step is a deployment.** Hosts auto-upgrade from `main` on their own
timer, so from here the rebuild in steps 10 and 15 happens with or without you.
Never merge a tree that step 7 has not passed against.

### 9. `flux: reconcile the spindrift CA bundle`

    flux reconcile source git infra
    flux -n spindrift reconcile kustomization apps

`clusters/offsite/apps/spindrift/ca-bundle.yaml` is the one file
`NODE_EXTRA_CA_CERTS` names: `offsite-ca.pem` followed by all three of
`folly-ca-chain.pem`. Spindrift's runtime does no partial-chain verification, so
folly's three certificates have to be the same generation. They are, because
`post-rotate.sh` writes them as a unit — which is why step 5 and step 6 are one
invocation.

### 10. `nixos-rebuild offsite`

`retrofit` first, then `oldschool`. Build on the site's own builder, never in
WSL.

The model finds no violation in either cluster order — `offsite` first is chosen
for recovery cost, not correctness. It is the site you cannot walk to, and at
this point the superseded anchors are still escrowed and `main` is still
revertible.

### 11. `systemctl restart cfssl (offsite)`
### 12. `systemctl restart kube-controller-manager (offsite)`

    ssh retrofit sudo systemctl restart cfssl kube-controller-manager

**The rebuild restarts neither.** `sops-nix` compares decrypted plaintext to
decide restarts and the cluster CA and signer keys are unchanged, so `cfssl`
keeps serving the certificate it loaded at start and
`kube-controller-manager` never republishes `kube-root-ca.crt`.
`TestRebuildAloneLeavesCfsslAndKCMStale` is that state, and it is why these are
separate steps rather than a consequence of step 10.

### 13. `kubelet: refresh projected ca.crt (offsite)`

Waiting, not doing. The kubelet re-projects `kube-root-ca.crt` into every pod's
`ca.crt` within about a minute of step 12. Confirm before moving on:

    kubectl --context offsite -n spindrift get cm kube-root-ca.crt \
      -o jsonpath='{.data.ca\.crt}' | grep -c 'BEGIN CERTIFICATE'

Three, and the fingerprints must match `offsite-ca-chain.pem`.

### 14. `kubectl rollout restart openssl clients (offsite)`

    kubectl --context offsite -n monitoring rollout restart daemonset vector
    kubectl --context offsite -n spindrift rollout restart deployment spindrift

A refreshed projection reaches nothing until the process restarts:
`NODE_EXTRA_CA_CERTS` and Vector's CA file are both read once, at start. Go
clients need nothing here — they were never affected.

### 15. `nixos-rebuild folly`
### 16. `systemctl restart cfssl (folly)`
### 17. `systemctl restart kube-controller-manager (folly)`
### 18. `kubelet: refresh projected ca.crt (folly)`
### 19. `kubectl rollout restart openssl clients (folly)`

Steps 10 through 14 again, against `optiplex` (control plane), then `riptide`
and `shale`. `optiplex` is folly's only control-plane node and is disk-bound;
give the rebuild room and watch `/proc/pressure/io` rather than assuming it hung.

### 20. `1password: destroy the superseded anchors`

Only once every store on both clusters holds the new chain: `kube-root-ca.crt`,
every pod's `ca.crt`, both `--root-ca-file`s, `caFile`, `cfssl`, and Spindrift's
`NODE_EXTRA_CA_CERTS`. Until then the escrowed item from step 2 is the rollback,
and destroying it early is the one action in this runbook that cannot be undone.

## Rolling back

- **Before step 3** — nothing has changed. Stop.
- **Between steps 3 and 4** — restore the escrowed 1Password fields.
- **Between steps 4 and 8** — restore the escrowed fields and re-apply
  `terraform/pki`; the committed certificates on `main` were never touched.
- **After step 8** — `git revert` the certificates commit and let the fleet
  rebuild, then restart `cfssl` and `kube-controller-manager` on both control
  planes. The revert alone restarts neither.
- **After step 20** — there is no rollback. That is what step 20 means.

## What this runbook does not cover

Quorum safety — "no unintended coalition of holders reconstructs any secret, and
no single site or person loss makes anything unrecoverable" — is not in this
model and does not belong in it. It is a static combinatorial property of the
share sets, with no notion of time, ordering or cluster state; nothing in the
state machine above touches a holder. It is owned by the exhaustive table test
over the share sets, not by anything here.
