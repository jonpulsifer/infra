---
title: Identity
description: SPIRE on spore gives each folly node with a TPM 2.0 an identity rooted in its TPM, by LDevID or EK hash, gives its pods SPIFFE IDs, and lets a pod reach GCP with no key file.
---

SPIRE issues SPIFFE identities in the trust domain `lolwtf.ca`. The server runs on [spore](../hosts/spore.md). An agent on a folly node proves that it holds a TPM: by the LDevID, a TPM-resident key with a certificate from the DevID CA, that the attest service issued it, or by its endorsement key (EK) on the server's allow list. It then serves SVIDs, SPIFFE's X.509 and JWT credentials, to the pods on that node.

## Server

| Part | Job | Where it runs |
| --- | --- | --- |
| `spire-server` | Attests agents and signs SVIDs with its own CA, which lasts 24 hours. Agents reach it on TCP 8081 at `spore.lolwtf.ca`. | spore, data in `/var/lib/spire` |
| `tpm` node attestor | Checks an agent's EK hash against `/etc/spire/tpm-hashes`, and proves that its attestation key is in the same TPM. It reads no PCRs. It runs while `homelab.spire.ekHashes` is not empty. | spore, the boxboat `spire-tpm-plugin` built in `nix/lib/spire.nix` |
| `tpm_devid` node attestor | Checks the LDevID's chain against the DevID CA, the EK certificate's chain against the manufacturer CAs in `nix/services/spire/roots/`, and that the LDevID key and the EK are in one TPM. It runs when `homelab.spire.devid.enable` is true. | spore, built into SPIRE |
| `k8sbundle` notifier | Writes the server's bundle into folly's `spire/spire-bundle` at startup and on every CA rotation, as the ServiceAccount `spire-bundle-writer` | spore, in the server, when `homelab.spire.bundleNotifier.enable` is true |
| `spire-server-entries` | Creates, updates and prunes the registration entries to match git | spore, a oneshot after the server is healthy |
| `spire-server-fleet-entries` | Registers the nodes fleetd lists, and withdraws the ones it drops | spore, a oneshot that a path unit starts when fleetd rewrites `/var/lib/fleetd/spire-nodes.json`, and a timer every 10 minutes |
| `spire-server-agent-count` | Writes `spire_server_attested_agents` for the node exporter every minute | spore, a timer |

The server has no `k8s_psat` node attestor, so only a TPM can attest a node.

| SPIFFE ID | Issued to | Selector |
| --- | --- | --- |
| `spiffe://lolwtf.ca/spire/agent/tpm/<hash>` | An agent, by the EK plugin | `tpm:pub_hash:<hash>` |
| `spiffe://lolwtf.ca/spire/agent/tpm_devid/<fingerprint>` | An agent, by `tpm_devid` | `tpm_devid:subject:cn:<name>`, `tpm_devid:issuer:cn:<ca>`, `tpm_devid:ca:fingerprint:<sha1>` |
| `spiffe://lolwtf.ca/node/<name>` | A node alias, one entry for each attestor | `tpm:pub_hash:<hash>`, or `tpm_devid:subject:cn:<name>` |
| `spiffe://lolwtf.ca/ns/<ns>/sa/<sa>` | A pod, parented to its node's alias | `k8s:ns:<ns>`, `k8s:sa:<sa>` |

The hash is the SHA-256 of the EK public key in DER form, in lowercase hex. The fingerprint is the SHA-1 of the LDevID certificate. The attest service sets the LDevID's subject to `CN=<name>, serialNumber=<serial>, OU=<talos_class>, O=<site>`: the node's name, its SMBIOS serial, NetBox's `talos_class` and the site. Every JWT-SVID carries the issuer `https://spire.lolwtf.ca`, set by `homelab.spire.jwtIssuer`.

SPIRE 1.15.5's `tpm_devid` gives the selectors in the table and no others: no selector names the subject's OU or O. So an alias cannot select a class or a site, and each machine gets its own alias by subject CN.

- The `git-*` LDevID aliases follow `clusters/folly/inventory/nodes.yaml`. Each node with `tpm` `2.0`, its own or its model's, gets one. `nix/lib/inventory.nix` reads the nodes file at evaluation, so a `git-*` alias needs a spore deploy. A node fleetd lists in `spire-nodes.json` gets its `fleet-*` alias with no deploy. It fails the evaluation on any line outside the file's shape.
- Change EK hashes in `ekHashes` and workload entries in `workloads` of `nix/hosts/spore.nix`. The sync deletes any entry whose ID starts with `git-` and is not declared, and it leaves entries made by hand.
- An agent matches a node entry only when it has every selector, so each node has one alias by EK hash and one by LDevID CN. A node with no entry in `ekHashes` attests only by LDevID.
- Add a node's EK hash before its agent starts. The plugin refuses an EK that is not on the list.
- `homelab.spire.devid.caChains` takes one file for each issuing DevID CA, `folly-devid-ca-<name>.pem` in `terraform/pki/certs/`. The server reads the first certificate of each file, so list the CA files and not the bundle `folly-devid-ca.pem`. The fml intermediate or root in that pool would admit any certificate it signs.
- Run the CLI as root with `-socketPath /run/spire/server/private/api.sock`. Its default socket path is wrong for this server.
- The firewall admits the agent port and the exporter only from folly's `K8S_NODE_CIDR` and `CILIUM_POD_CIDR`. Cilium does not masquerade traffic to spore, so pods arrive from their own addresses.

### fleetd entries

Two owners write registration entries, and the entry ID says which.

| Owner | IDs | Holds |
| --- | --- | --- |
| Nix, `spire-server-entries` | `git-*` | The entries in `homelab.spire.entries` of `nix/hosts/spore.nix`: the alias for each node in `ekHashes` and each node of `nodes.yaml` with a TPM 2.0, and the `workloads` under them |
| fleetd and `spire-server-fleet-entries` | `fleet-*` | The same aliases and `workloads` for each node in `spire-nodes.json`, and the eviction of a withdrawn node's agent |

fleetd writes `spire-nodes.json` from NetBox and holds no SPIRE credential. The applier runs as root on the server's socket, takes only a node name that matches `[a-z0-9-]` and EK hashes of 64 lowercase hex characters, and leaves every entry as it is when the file is malformed. A node is in the file while its device is `active` with the verdict `attested`. When it leaves, the applier deletes the node's `fleet-*` entries and evicts each agent whose node selector no entry carries any longer. An evicted agent attests again while its LDevID is valid, and gets no workload entries without an alias.

SPIRE rejects an entry that repeats another's parent, SPIFFE ID and selectors. The applier skips an entry that a `git-*` entry, or one made by hand, already issues, and the Nix sync deletes a `fleet-*` entry that an entry it declares repeats. The declared entry wins in both orders, and no alias is missing while a node moves from one owner to the other.

## The chain

A node's identity starts before Talos runs. Each step relies on the one before it.

| Step | Proves | Where it runs |
| --- | --- | --- |
| EK certificate | The TPM is a genuine Infineon or Nuvoton part | The TPM maker's CA, pinned in `apps/fleetd/attest/roots/` |
| Credential activation | The attestation key (AK) is in that TPM | [fleetd](../apps/fleetd.md), from HookOS |
| Quote and event log | The machine booted with Secure Boot on, under the lab's PK, through the signed iPXE and HookOS | fleetd, against `apps/fleetd/attest/policy.yaml` |
| TPM2_Certify | The LDevID key is in that TPM and cannot leave it | fleetd |
| LDevID and LAK certificates | The DevID CA vouches for the key and the AK | `FML DevID folly CA`, in [PKI](pki.md#chain) |
| `tpm_devid` | The agent holds the LDevID key in a TPM with a genuine EK | spore's SPIRE server |

[Provision a node](../runbooks/provision-a-node.md) runs the first five steps.

## Lifecycle

A folly node's identity follows its device's `status` in [NetBox](netbox.md). fleetd and SPIRE read it.

| Status | Meaning | Written by |
| --- | --- | --- |
| `planned` | Ordered, with its serial known, or in attestation or install. It may carry an approved EK binding and `ek_hash` pins. | The owner, through the nodes file; fleetd, on a `provision` or `wipe` of an installed node |
| `active` | Its config is released, and it is expected Ready | fleetd, when the node fetches its config |
| `failed` | Held out by the owner | The owner |
| `decommissioning` | Retiring: the disk is wiped, and the exports drop it | The owner |
| `offline` | Retired, and kept for history | fleetd, after the retirement run succeeds |

Only the owner moves a device out of `failed` or into `decommissioning`, and fleetd refuses a `failed` device. A quarantine is a verdict, and the status stays: a quote that misses the policy sets `attest_verdict` to `quarantined: <reason>`, fleetd answers the node's `/devid` with 403 and cordons the node. fleetd refuses it a new identity until the owner clears the verdict. After that the node's next daily check or renewal, which proves its LAK and LDevID key and passes the policy, restores its record and its LDevID files, and the owner uncordons the node. A control plane's failed quote reads `failed-no-quarantine: <reason>` and only alerts. A `decommissioning` or `offline` device gets no LDevID renewal, so its identity ends when its LDevID expires. [Provision a node](../runbooks/provision-a-node.md), [Reprovision a node](../runbooks/reprovision-a-node.md) and [Retire a node](../runbooks/retire-a-node.md) are the procedures.

## Agents

The DaemonSet `spire-agent` in the `spire` namespace runs on each folly node labelled `lolwtf.ca/tpm=true`. Its image, `ghcr.io/jonpulsifer/spire-agent-tpm`, adds the agent half of the EK plugin and `spire-devid-init` to SPIRE's agent.

The init container `devid-init` reads the node's SMBIOS serial and fetches `<ATTEST_URL>/devid/<serial>` from fleetd's DevID listener on spore, with `ATTEST_URL` from the `spire-attest` ConfigMap. When the LDevID names this node and serial, is current and matches its key blob, it writes the files and renders the agent's config with `tpm_devid`. Otherwise, or with `ATTEST_URL` empty, it renders the EK attestor. The `tpm_devid` agent keeps its state in `/var/lib/spire-agent/tpm_devid`. The blobs are wrapped by the TPM's storage root key, which the agent derives from the TCG H-1 or H-2 template, so they load on no other TPM.

The container is privileged, since the device cgroup refuses `/dev/tpmrm0` to any other container. It shares the host's PID namespace and network, so the `k8s` workload attestor can ask the kubelet for a caller's pod. Its key and SVID stay in `/var/lib/spire-agent` on the node, so a new pod resumes with no second attestation.

A pod reaches the Workload API at `/run/spire/sockets/agent.sock` through a hostPath volume, which needs a privileged namespace. A node with no label runs no agent, so its pods get no SVID. The Job `spire-smoke` prints the SPIFFE ID that the agent serves it.

- An agent's first attestation trusts the `spire-bundle` ConfigMap. spore's notifier pushes the bundle into it, and Flux declares no `data`, so its server-side apply never overwrites the push. If the ConfigMap is empty or older than the server's CA, a new agent fails.
- The notifier reads folly's API server from `cluster-topology.json`, the CA from `clusters/folly/config/kubernetes-ca.pem`, and the token from `spire/folly-bundle-writer-token` in `nix/secrets/spore.sops.yaml`. If it cannot write the bundle at startup, the server exits and retries every 30 seconds. A push that fails at a rotation waits for the next rotation or restart.
- Reloader restarts the agents when `spire-agent` or `spire-attest` changes, not when the bundle changes. An attested agent follows the rotations itself.
- A workload gets an SVID only after spore registers its entry under its node's alias.
- A node pulls the agent image only while its GHCR package is public.

[Add a TPM node to SPIRE](../runbooks/add-a-tpm-node-to-spire.md) admits a node by LDevID or EK hash, turns on `tpm_devid`, and turns on the bundle notifier.

## Renewal

The DaemonSet `tpm-reattest` in the `spire` namespace runs `tink-attest renew -every 24h` on each node labelled `lolwtf.ca/tpm=true`, as `clusters/folly/apps/spire/tpm-reattest.yaml` declares. It reads the LDevID and LAK certificates from NV `0x01c90000` and `0x01c90001`. When the LDevID expires within 30 days, or NV holds the LAK and no LDevID, it renews the LDevID on fleetd's DevID listener, at the same `ATTEST_URL` as `devid-init`. fleetd issues the renewal from spore's YubiKey CA, whatever CA issued the LDevID on file. Otherwise it runs the daily check, which the next section describes.

1. It fetches `/devid/<serial>` and checks that the key blobs are the keys the certificates in NV name.
2. `POST /v1/renew` with the serial answers a session and a nonce.
3. It loads the LAK and the LDevID key under the H-2 storage root key. With the LAK it quotes PCRs 0 to 7 and certifies the LDevID key, both qualified by the nonce.
4. `POST /v1/renew/<session>/evidence` carries the quote, the PCR values, the event log from securityfs, and the certification. The service replays the log as at intake and answers a new certificate for the same key.
5. It checks that the certificate chains to a DevID CA in the ConfigMap `spire-devid-ca`, certifies the same key, and names the node and its serial. The routes are plain HTTP, so this check is what keeps a forged answer out of NV.
6. It writes a renewed LAK certificate first, then the LDevID certificate, so a failed write leaves the renewal due for the next run. It then deletes the `spire-agent` pod on its node, and fails when no pod matches. The new pod's `devid-init` fetches the new certificate.

`scripts/render-spire-devid-ca.sh` writes `spire-devid-ca` from `terraform/pki/certs/folly-devid-ca.pem`, and the kustomize workflow fails when the two differ. A run that fails runs again an hour later. A node with no LDevID in NV has nothing to renew. The ServiceAccount `tpm-reattest` may list and delete pods in `spire`. The ValidatingAdmissionPolicy `tpm-reattest` allows it to delete only a `spire-agent` pod on the node that its token names. `TalosAttestLDevIDExpiring` fires when an LDevID expires within 23 days, which is a week of failed renewals.

### Daily check

On a day with no renewal due, the run takes steps 1 to 4 with `check` set in the request and the BIOS version from `/sys/class/dmi/id/bios_version` in the evidence. The service judges the boot by the renewal policy, records the verdict, `last_attested` and PCR 0 in NetBox, and answers no certificate, so NV and the `spire-agent` pod stay as they are. A boot that misses the policy after the LAK's proof quarantines a worker: its `attest_verdict` reads `quarantined: <reason>`, and fleetd serves it no LDevID and cordons it. A `controlplane` node stays in place and alerts at critical, so the cluster's API stays up. [fleetd](../apps/fleetd.md) has the rules.

A run opens `/dev/tpmrm0` and reads the event log before it sends anything. Without the TPM it logs `NO TPM`, sends nothing, and tries again an hour later; a node whose TPM is off has no device to mount, so its pod does not start. A service that predates the check answers without `check`, and the run sends it no evidence. `TalosAttestNotChecked` fires when fleetd has recorded no passing quote from a node for 26 hours.

## GCP access

| Part | Job | Where it runs |
| --- | --- | --- |
| `oidc-discovery-provider` | Publishes the keys that check JWT-SVIDs, as the issuer `https://spire.lolwtf.ca` | Two pods in `spire-oidc`, each on a different labelled node |
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

riptide and optiplex carry the `lolwtf.ca/tpm=true` label and run agents. riptide's agent attests by its LDevID, and optiplex's by EK hash. The allow list holds the EK hashes of both. shale has a TPM 1.2 and runs no agent. The smoke Job is suspended.

## Where it lives

- `nix/services/spire-server.nix`: the server, both node attestors, the bundle notifier, the entry sync, the agent count and the firewall
- `nix/services/spire/roots/`: the Infineon and Nuvoton EK CAs that `tpm_devid` trusts, the same files as `apps/fleetd/attest/roots/`
- `apps/fleetd/` and `nix/services/fleetd.nix`: fleetd and its deployment on spore
- `nix/hosts/spore.nix`: `ekHashes`, `workloads` and the registration entries
- `nix/lib/inventory.nix`: the nodes file as Nix, for the LDevID aliases and talos-attest's inventory
- `nix/lib/spire.nix`: the SPIRE and plugin builds, with `nix/lib/spire-tpm-plugin-sdk.patch`
- `clusters/folly/apps/`: the agent, its bundle, the bundle writer, `tpm-reattest` and the smoke Job in `spire/`, the discovery provider in `spire-oidc/`, and the GCP test in `spire-test/`
- `images/`: the agent image in `spire-agent-tpm/`, with `spire-devid-init` in `spire-agent-tpm/devid-init/`
- `terraform/gcp/projects/homelab-ng/workload-identity.tf`: the provider `spire` in `fml-pool`, with the test bucket and its grant in `spire-test.tf` beside it
- `terraform/network/cloudflare/lolwtf.ca.tf`: the tunnel rule for `spire.lolwtf.ca`
- `clusters/folly/monitoring/spore.yaml`: the scrape and the SPIRE alerts
- `clusters/folly/config/cluster-topology.json`: `K8S_NODE_CIDR`, `CILIUM_POD_CIDR`, `API_SERVER_HOSTNAME`, `API_SERVER_PORT`

## Related

- [PKI](pki.md#workload-identity): the cluster ServiceAccount issuers in the same pool
- [Cloud](cloud.md)
- [spore](../hosts/spore.md)
