# tally on folly

The household ledger from `apps/tally`, in the `tally` namespace. Flux applies
this directory from `clusters/folly/apps/kustomization.yaml`.

| File | What it declares |
| --- | --- |
| `namespace.yaml` | The namespace, at the `restricted` Pod Security level. |
| `external-secret.yaml` | The Secret `tally`, from the 1Password item `tally`. |
| `config.yaml` | `TALLY_OWNERS`, the tailnet logins that own a ledger. |
| `database.yaml` | The CNPG Cluster `tally-db`, its WAL archive and nightly base backup to Garage, and the PodMonitor `CNPGBackupStale` reads. |
| `deployment.yaml` | The api pod: `tally serve` on 8080, with the web app. |
| `ocr-worker.yaml` | The OCR worker, at zero replicas. |
| `service.yaml` | The api's Service. |
| `tailnet-ingress.yaml` | The only entry, `https://tally.<tailnet>.ts.net`, a tailscale L7 Ingress. |
| `network-policy.yaml` | What each pod may reach and be reached by. |

## Why the entry is on the tailnet

The api decides who is asking from `Tailscale-User-Login`. The tailscale
Ingress sets that header and overwrites a copy the client sends, so the
header is true only when the request came through it. A route on folly's
`cluster-gateway` would let any LAN client name any login, so tally has none,
and `network-policy.yaml` admits only the Ingress's proxy. folly's Cilium
runs with `allow-localhost=always`, so processes on the api pod's own node
(the kubelet's probes among them) reach it with no rule, and the header is
only as true as that node. The OCR worker is not admitted: it parses
untrusted PDFs, so it gets its own listener and token when its queue exists.

## What leaves the lab

The api pod's egress is DNS for `cluster.local` and the provider names,
`tally-db`, and port 443 on `api.openai.com`, `auth.openai.com` and
`chatgpt.com`. Only merchant descriptor strings go to those hosts, with
number-shaped identifiers replaced first. No other name resolves, so a DNS
query cannot carry data out. The OCR worker resolves names in this namespace
alone and reaches nothing. The database instance has no policy, as with mate-db:
the operator, the scrape and the WAL archive reach it. Its rows are sealed by
the app, so the backups in Garage hold ciphertext.

## Owner-only steps

1. Create the 1Password item `tally` in the vault `homelab`, in the 1Password
   app rather than with `op` assignments, which land in shell history. Its
   fields:

   | Field | Value |
   | --- | --- |
   | `keyring` | The keyring JSON, `{"active": "v1", "keys": {"v1": "<32 random bytes, base64>"}}`, base64-encoded again, because a concealed field is one line. |
   | `openai-api-key` | Optional. The key for `TALLY_PROVIDER=openai_api`. |
   | `codex-auth` | Optional. Not mounted: the ChatGPT route needs the codex CLI in the image first. |

   Until the item exists the ExternalSecret fails to sync and the api pod
   does not start. Back up the keyring outside 1Password too:
   without it the database and every backup are unreadable.
2. Merge the change. The containers workflow builds `tally` and `tally-ocr`
   on `main`, and its delivery pull request replaces the all-zero digests in
   `deployment.yaml` and `ocr-worker.yaml`. Until it merges the api pod is in
   `ImagePullBackOff`.
3. A viewer who is not the tailnet owner needs a grant to the Ingress's proxy
   in `terraform/network/tailscale/policy.hujson`, as `tag:kthx-ingress` has.
   The owner reaches it through the `autogroup:owner` grant to every tagged
   device.
