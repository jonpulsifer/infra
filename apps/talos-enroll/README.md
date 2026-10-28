# talos-enroll

talos-enroll answers the OAuth device flow that a Talos machine runs before it
fetches `talos.config`, and releases the machine's config once the owner
approves it. See [Talos enrollment](https://wiki.lolwtf.ca/apps/talos-enroll/).

## Run

```bash
go build -o talos-enroll .
talosctl gen secrets -o /tmp/secrets.yaml
ENROLL_MACHINE_INPUTS=../../clusters/folly/apps/talos-enroll/machine-inputs.json \
ENROLL_NODE_MACS=../../clusters/folly/apps/talos-enroll/node-macs.json \
ENROLL_SECRETS_BUNDLE=/tmp/secrets.yaml \
ENROLL_DISCORD_WEBHOOK_FILE=/dev/null \
ENROLL_APPROVERS=you@example.com \
ENROLL_ADMIN_URL=http://localhost:8081 \
./talos-enroll
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENROLL_ADDR` | `:8080` | The listener Talos reaches through the Gateway or the anchors' nginx. `unix:<path>` makes a socket with mode 0660. |
| `ENROLL_ADMIN_ADDR` | `:8081` | The listener the owner reaches through the tailnet Ingress or `tailscale serve`. `unix:<path>` makes a socket with mode 0600. |
| `ENROLL_CLIENT_ID` | `talos-enroll` | The `talos.config.oauth.client_id` baked into the UKI |
| `ENROLL_MACHINE_INPUTS` | `/etc/talos-enroll/machine-inputs.json` | Per-node render inputs, written by `mise run render-machine-inputs` |
| `ENROLL_NODE_MACS` | `/etc/talos-enroll/node-macs.json` | Node to MAC hints for the approval prompt. Optional. |
| `ENROLL_SECRETS_BUNDLE` | `/var/run/secrets/talos-enroll/bundle/secrets.yaml` | The cluster's `talosctl gen secrets` bundle |
| `ENROLL_DISCORD_WEBHOOK_FILE` | `/var/run/secrets/talos-enroll/discord/webhook-url` | A file holding the Discord webhook URL |
| `ENROLL_APPROVERS` | none, required | Comma-separated tailnet logins that may approve and deny |
| `ENROLL_ADMIN_URL` | none, required | The admin listener's public URL, for prompts and `verification_uri` |
| `ENROLL_TALOSCTL` | `talosctl` | The talosctl binary. It must match the Talos root's `talos_version`. |

## Public routes

The Gateway routes only the first three. Talos sends every request with Go's
default client, and the token poll twice, with and without Basic auth.

| Route | Does |
| --- | --- |
| `POST /device/code` | Takes `client_id`, `uuid`, `mac`, `serial`, `hostname` as a form. Answers `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` 900 and `interval` 5. A newer request from the same `uuid` replaces the older one. A denied `uuid` gets 403 `access_denied`. |
| `POST /token` | Takes `client_id`, `grant_type` (the device code grant) and `device_code`. Answers 400 `authorization_pending`, `access_denied` or `expired_token`, or 200 with a `Bearer` token that lives 30 minutes. It ignores `Authorization`. |
| `GET /config?uuid=…` | With `Authorization: Bearer <token>`, answers 200 with the node's machine config once. A query that holds a literal `${` is 400, a `uuid` other than the token's is 403, and a used or expired token is 401. A write that fails leaves the token valid. |
| `GET /healthz` | Health check |
| `GET /metrics` | Prometheus metrics |

## Admin routes

Every route requires `Tailscale-User-Login` in `ENROLL_APPROVERS`. A POST with
an `Origin` from another host is refused.

The user code goes only to the machine, which shows it on its console. No
prompt, log, list or page carries it, so the owner approves the code read off
the console, and a device request made in another machine's name cannot be
approved by mistake.

| Route | Does |
| --- | --- |
| `GET /` | The approval page. `?code=`, from the console's QR code, fills in the code and marks its machine. |
| `GET /pending` | The waiting enrollments, without their user codes, and the nodes it can render, as JSON |
| `POST /approve` | Takes `code` and `node` as a form. Renders that node's config, then issues the token. A render that fails leaves the enrollment pending. |
| `POST /deny` | Takes `uuid` as a form. Refuses its enrollment and every later request from it until the server restarts |

`talos_enroll_longest_wait_seconds` runs from a machine's first device request
until approval or denial, across its codes. A machine that stays quiet for 5
minutes past its code's expiry stops counting.

## Render

`talosctl gen config <cluster_name> <cluster_endpoint> --with-secrets /dev/stdin
--talos-version <talos_contract> --kubernetes-version <kubernetes_version>
--with-docs=false --with-examples=false -t <machine_type> -o -`, with one
`--config-patch-control-plane` or `--config-patch-worker` per entry of
`config_patches`, in order. With the same inputs, the Talos provider renders the
same bytes.

## Test

```bash
go test ./...
```

`TestTalosctlRender` runs only where `talosctl` is on `PATH`.
