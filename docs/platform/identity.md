---
title: Identity
description: SPIRE on spore gives each folly node with a TPM 2.0 an identity rooted in its TPM, gives its pods SPIFFE IDs, and lets a pod reach GCP with no key file.
---

SPIRE issues SPIFFE identities in the trust domain `lolwtf.ca`. The server runs on [spore](../hosts/spore.md). An agent on a folly node proves that it holds a TPM whose endorsement key (EK) is on the server's allow list. It then serves SVIDs, SPIFFE's X.509 and JWT credentials, to the pods on that node.

## Server

| Part | Job | Where it runs |
| --- | --- | --- |
| `spire-server` | Attests agents and signs SVIDs with its own CA, which lasts 24 hours. Agents reach it on TCP 8081 at `spore.lolwtf.ca`. | spore, data in `/var/lib/spire` |
| TPM node attestor | Checks an agent's EK hash against `/etc/spire/tpm-hashes`, and proves that its attestation key is in the same TPM. It reads no PCRs. | spore, the boxboat `spire-tpm-plugin` built in `nix/lib/spire.nix` |
| `spire-server-entries` | Creates, updates and prunes the registration entries to match git | spore, a oneshot after the server is healthy |
| `spire-server-agent-count` | Writes `spire_server_attested_agents` for the node exporter every minute | spore, a timer |

The server has no `k8s_psat` node attestor, so only a TPM can attest a node.

| SPIFFE ID | Issued to | Selector |
| --- | --- | --- |
| `spiffe://lolwtf.ca/spire/agent/tpm/<hash>` | An agent, by the plugin | `tpm:pub_hash:<hash>` |
| `spiffe://lolwtf.ca/node/<name>` | A node alias for one EK hash | `tpm:pub_hash:<hash>` |
| `spiffe://lolwtf.ca/ns/<ns>/sa/<sa>` | A pod, parented to its node's alias | `k8s:ns:<ns>`, `k8s:sa:<sa>` |

The hash is the SHA-256 of the EK public key in DER form, in lowercase hex. Every JWT-SVID carries the issuer `https://spire.lolwtf.ca`, set by `homelab.spire.jwtIssuer`.

- Change entries and EK hashes in `tpmNodes` and `workloads` of `nix/hosts/spore.nix` only. The sync deletes any entry whose ID starts with `git-` and is not declared, and it leaves entries made by hand.
- Add a node's EK hash before its agent starts. The plugin refuses an EK that is not on the list.
- Run the CLI as root with `-socketPath /run/spire/server/private/api.sock`. Its default socket path is wrong for this server.
- The firewall admits the agent port and the exporter only from folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR`. Cilium does not masquerade traffic to spore, so pods arrive from their own addresses.

## Agents

The DaemonSet `spire-agent` in the `spire` namespace runs on each folly node labelled `lolwtf.ca/tpm=true`. Its image, `ghcr.io/jonpulsifer/spire-agent-tpm`, adds the agent half of the TPM plugin to SPIRE's agent.

The container is privileged, since the device cgroup refuses `/dev/tpmrm0` to any other container. It shares the host's PID namespace and network, so the `k8s` workload attestor can ask the kubelet for a caller's pod. Its key and SVID stay in `/var/lib/spire-agent` on the node, so a new pod resumes with no second attestation.

A pod reaches the Workload API at `/run/spire/sockets/agent.sock` through a hostPath volume, which needs a privileged namespace. A node with no label runs no agent, so its pods get no SVID. The Job `spire-smoke` prints the SPIFFE ID that the agent serves it.

- An agent's first attestation trusts the `spire-bundle` ConfigMap. If it is empty or older than the server's CA, a new agent fails.
- A workload gets an SVID only after spore registers its entry under its node's alias.
- A node pulls the agent image only while its GHCR package is public.

[Runbooks](../runbooks/index.md) has Add a TPM node to SPIRE, which reads a node's EK hash, admits the node and refreshes `spire-bundle`.

## GCP access

| Part | Job | Where it runs |
| --- | --- | --- |
| `oidc-discovery-provider` | Publishes the keys that check JWT-SVIDs, as the issuer `https://spire.lolwtf.ca` | A pod in `spire-oidc` on a labelled node |
| folly Cloudflare Tunnel | Serves `/.well-known/openid-configuration` and `/keys` on `spire.lolwtf.ca`, and no other path | Cloudflare, to the provider's Service |
| `fml-pool` provider `spire` | Trades a JWT-SVID for a GCP token whose subject is the SPIFFE ID | GCP |

A workload gets GCP access in four steps.

1. spore registers its SPIFFE ID.
2. A grant in `terraform/gcp/projects/homelab-ng/` names the principal `principal://iam.googleapis.com/<fml-pool>/subject/spiffe://lolwtf.ca/ns/<ns>/sa/<sa>`.
3. The pod mounts the agent socket and runs `spire-agent api fetch jwt` with the audience `//iam.googleapis.com/<fml-pool>/providers/spire`.
4. The pod writes the SVID to a file, and an `external_account` credential config whose `credential_source` is that file. With no `service_account_impersonation_url`, GCP sees the SPIFFE ID itself.

`<fml-pool>` is `projects/<project-number>/locations/global/workloadIdentityPools/fml-pool`. A JWT-SVID is short-lived, so a long-running workload rewrites the file before it expires.

The test Job in `spire-test` runs as `uploader`, which can only create objects in the bucket `homelab-ng-spire-test`. Its log names the SPIFFE ID and the object it wrote. Bump the suffix of the Job's name to run it again.

- The provider `spire` admits every SPIFFE ID in the trust domain. Grant on one subject, never on the pool or on an `attribute.spiffe_id` prefix.
- The server's `jwt_issuer`, the discovery provider's `jwt_issuer` and the provider's `issuer_uri` are one value. GCP rejects an SVID whose `iss` differs.
- The discovery provider reads its keys through the Workload API as `spire-oidc/oidc-discovery-provider`. Without that entry, `spire.lolwtf.ca` serves no keys and every exchange fails.
- `iam.workloadIdentityPoolProviders` in `terraform/gcp/projects/homelab-ng/policy.tf` lists the issuer. A new issuer needs an entry there first.

## Live state

No folly node carries the `lolwtf.ca/tpm=true` label, and `spire-bundle` is empty. No agent runs, so `SpireNoAttestedAgents` fires, and no pod gets an SVID. The smoke Job is suspended, since a pod that no node can schedule keeps it active until `KubeJobNotCompleted` fires.

The allow list holds riptide's EK hash. optiplex has none until Intel PTT is on.

## Where it lives

- `nix/services/spire-server.nix`: the server, the entry sync, the agent count and the firewall
- `nix/hosts/spore.nix`: `tpmNodes`, `workloads` and the registration entries
- `nix/lib/spire.nix`: the SPIRE and plugin builds, with `nix/lib/spire-tpm-plugin-sdk.patch`
- `clusters/folly/apps/`: the agent, its bundle and the smoke Job in `spire/`, the discovery provider in `spire-oidc/`, and the GCP test in `spire-test/`
- `images/`: the agent image in `spire-agent-tpm/`
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: the provider `spire` in `fml-pool`, with the test bucket and its grant in `spire-test.tf` beside it
- `terraform/network/cloudflare/lolwtf.ca.tf`: the tunnel rule for `spire.lolwtf.ca`
- `clusters/folly/monitoring/spore.yaml`: the scrape and the SPIRE alerts
- `clusters/folly/config/cluster-topology.json`: `K8S_NODE_CIDR`, `CILIUM_POD_CIDR`

## Related

- [PKI](pki.md#workload-identity): the cluster ServiceAccount issuers in the same pool
- [Cloud](cloud.md)
- [spore](../hosts/spore.md)
