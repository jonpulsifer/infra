---
title: Node identity
description: The SPIRE server on spore, which gives Talos nodes an identity rooted in their TPM and gives their workloads SPIFFE IDs.
---

SPIRE issues SPIFFE identities in the trust domain `lolwtf.ca`. The server runs on [spore](../hosts/spore.md). A Talos node's agent proves that it holds a TPM whose endorsement key (EK) is on the server's allow list, and the server then issues identities to the node and to its workloads.

No cluster runs an agent today, so the server has no attested agent and `SpireNoAttestedAgents` fires.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `spire-server` | Attests agents and signs SVIDs with its own CA, which lasts 24 hours. Agents reach it on TCP 8081. | spore, data in `/var/lib/spire` |
| TPM node attestor | Checks an agent's EK public key hash against `/etc/spire/tpm-hashes` and proves that its attestation key is in the same TPM | spore, the boxboat `spire-tpm-plugin` built in `nix/lib/spire.nix` |
| `spire-server-entries` | Creates, updates and prunes the registration entries to match git | spore, a oneshot after the server is healthy |
| `spire-server-agent-count` | Writes `spire_server_attested_agents` for the node exporter every minute | spore, a timer |

The server has no `k8s_psat` node attestor, so only a TPM can attest a node.

## Identities

| SPIFFE ID | Issued to | Selector |
| --- | --- | --- |
| `spiffe://lolwtf.ca/spire/agent/tpm/<hash>` | An agent, by the plugin | `tpm:pub_hash:<hash>` |
| `spiffe://lolwtf.ca/node/<name>` | A node alias for one EK hash | `tpm:pub_hash:<hash>` |
| `spiffe://lolwtf.ca/ns/<ns>/sa/<sa>` | A pod, parented to its node's alias | `k8s:ns:<ns>`, `k8s:sa:<sa>` |

The hash is the SHA-256 of the EK public key in DER form, in lowercase hex.

Every JWT-SVID carries the issuer `https://spire.lolwtf.ca`, set by `homelab.spire.jwtIssuer`. The OIDC discovery provider serves the JWKS at that address and gets its own SVID as `spire-oidc/oidc-discovery-provider`.

## Rules

- Change entries and EK hashes in `nix/hosts/spore.nix` only. The sync deletes any entry whose ID starts with `git-` and is not declared, and it leaves entries made by hand.
- Add a node's EK hash before its agent starts. The plugin refuses an EK that is not on the list.
- Run the CLI as root with `-socketPath /run/spire/server/private/api.sock`. Its default socket path is wrong for this server.
- The firewall admits the agent port and the exporter only from folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR`. Cilium does not masquerade traffic to spore, so pods arrive from their own addresses.

## Where it lives

- `nix/services/spire-server.nix`: the server, the entry sync, the agent count and the firewall
- `nix/hosts/spore.nix`: `tpmNodes`, each node's EK hash, and the workloads that get an SVID
- `nix/lib/spire.nix`: the SPIRE and plugin builds, with `nix/lib/spire-tpm-plugin-sdk.patch`
- `clusters/folly/monitoring/spore.yaml`: the scrape and the SPIRE alerts
- `clusters/folly/config/cluster-topology.json`: `K8S_NODE_CIDR`, `CILIUM_POD_CIDR`

## Related

- [PKI](pki.md)
- [spore](../hosts/spore.md)
