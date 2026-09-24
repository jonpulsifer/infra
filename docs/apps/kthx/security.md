---
title: Ownership and security
description: Which system owns each part of kthx, the identities and federation each part uses, and how built images are signed and admitted.
---

OpenTofu, Flux and the kthx engine each own part of [kthx](../kthx.md). [Built apps](built-apps.md#concepts) defines the nouns.

## Who owns what

| Part | Owner | Source of truth |
| --- | --- | --- |
| Vessels, tunnels and signing keys | OpenTofu, applied by Atlantis | `terraform/` |
| The engine, quick sites, Target RBAC and the image policy | Flux | `clusters/` |
| App namespaces, releases, DNS records and Datastores | The engine, through Target APIs | Its database |
| Engine settings, such as Targets and build routes | The engine | Its database, exported from the console's Settings page |

The engine deletes only namespaces labelled `app.kubernetes.io/managed-by: spindrift`. Target RBAC cannot touch Secrets, so Datastore credentials reach Apps through External Secrets.

## Identities

| Caller | Credential | Can |
| --- | --- | --- |
| The owner | A console passkey, enrolled once with `SPINDRIFT_ENROLMENT_TOKEN` | Every console and MCP action |
| An agent on `/mcp` | An agent token, valid 90 days | Every action except minting tokens |
| kthx on GitHub | The private GitHub App `spindrift-bot` (ID `4576122`), installed on `jonpulsifer` only | Push branches, open pull requests and run workflows in connected repositories |
| A quick-site owner | Its bearer token or tailnet login | Upload, roll back and delete that site |

## Secrets

`clusters/offsite/apps/spindrift/secret.sops.yaml` holds the engine's secrets.

| Secret | Also in | If missing |
| --- | --- | --- |
| Enrolment token | | Nobody can enrol a passkey |
| Vercel and Cloudflare tokens | | Their Targets cannot connect |
| GitHub App key | 1Password and `nix/secrets/bosun.sops.yaml`. Update all three before you delete an old key. | kthx has no GitHub App until the console creates one |
| `SPINDRIFT_GITHUB_WEBHOOK_SECRET` | | The engine refuses every GitHub webhook |

## Quick-site trust

Quick sites trust `Tailscale-User-Login` only on [`kthx.<tailnet>`](../../hosts/index.md#reach-a-host), where `KTHX_ADMIN_LOGINS` can delete every site and free every name. Network policies `kthx` and `kthx-gateway` admit only the Tailscale proxy, Gateway, kubelet and namespace pods. Rate limits key reliably only on traffic that arrives through Cloudflare.

## Federation

The engine runs as ServiceAccount `spindrift/spindrift` on offsite, with no GCP or cluster key.

- GCP: The `offsite` provider of the `fml-pool` workload identity pool lets it impersonate `spindrift-controller@bluenose` (`terraform/gcp/projects/bluenose/iam.tf`).
- folly: The API server accepts its token as user `federated:system:serviceaccount:spindrift:spindrift` (`nix/services/k8s/default.nix`).
- Vercel and Cloudflare: none. The engine uses [stored tokens](#secrets).

Quick sites run as `kthx-server@bluenose`, which reaches only bucket `bluenose-kthx`.

## Supply chain

- The engine verifies each Build's provenance, then signs the image digest with a KMS key in the trusted-builds GCP project.
- Kyverno policy `spindrift-verify-images` on both clusters rejects an App pod without that signature.
- On Cloud Run, the Vessel's Binary Authorization policy admits only attested images.
- `github-actions` builds reach GCP through the `homelab` workload identity pool as the workflow `spindrift-build.yml` on `main`.
