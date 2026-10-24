---
title: Identity
description: SPIRE gives each folly node with a TPM 2.0 a node identity rooted in its TPM, and gives the pods on it SPIFFE IDs.
---

SPIRE issues SPIFFE identities in the trust domain `lolwtf.ca` from a server on [spore](../hosts/spore.md). An agent on each folly node with a TPM 2.0 proves its node with the TPM, then serves SVIDs, SPIFFE's X.509 and JWT credentials, to the pods there.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| SPIRE server | Admits an agent whose TPM endorsement key (EK) hash is on its allow list, and signs SVIDs | spore, TCP 8081 at `spore.lolwtf.ca` |
| SPIRE agent | Attests its node by TPM and serves the Workload API | DaemonSet `spire-agent` in the `spire` namespace on folly, on nodes labelled `lolwtf.ca/tpm=true` |
| Smoke Job | Prints the SPIFFE ID the agent serves it, about every hour | Job `spire-smoke` in the `spire-smoke` namespace |

## Agents

| Identity | SPIFFE ID | Selected by |
| --- | --- | --- |
| Agent | `spiffe://lolwtf.ca/spire/agent/tpm/<ek-hash>` | The TPM plugin |
| Node alias | `spiffe://lolwtf.ca/node/<name>` | `tpm:pub_hash:<ek-hash>` |
| Workload | `spiffe://lolwtf.ca/ns/<ns>/sa/<sa>` | `k8s:ns:<ns>` and `k8s:sa:<sa>`, with the node alias as parent |

The agent image adds the community TPM node attestor, boxboat/spire-tpm-plugin, to SPIRE's agent. The plugin proves that the agent's attestation key and the EK are in one TPM. It reads no PCRs: a node that cannot open its TPM-sealed disks never starts the agent.

The agent container is privileged, since the device cgroup refuses `/dev/tpmrm0` to any other container. It shares the host's PID namespace and network, so the `k8s` workload attestor can ask the kubelet for a caller's pod. Its key and SVID stay in `/var/lib/spire-agent` on the node, so a new pod resumes with no second attestation.

A pod reaches the Workload API at `/run/spire/sockets/agent.sock` through a hostPath volume, which needs a privileged namespace. A node with no label runs no agent, so its pods get no SVID.

## Rules

- An agent's first attestation trusts the `spire-bundle` ConfigMap. If it is empty or older than the server's CA, a new agent fails. [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md) refreshes it.
- A workload gets an SVID only after spore registers its entry under the alias of its node.
- A node pulls the agent image only while its GHCR package is public.

## Live state

No folly node carries the `lolwtf.ca/tpm=true` label, and `spire-bundle` is empty. No agent runs until the Talos root labels riptide and optiplex and spore's server runs.

## Where it lives

- `clusters/folly/apps/spire/`: the agent DaemonSet, its config, the bootstrap bundle and the smoke Job
- `images/spire-agent-tpm/Dockerfile`: the agent image

## Related

- [Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md)
- [PKI](pki.md)
