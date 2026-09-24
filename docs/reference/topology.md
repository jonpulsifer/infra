---
title: Topology
description: The two JSON files that hold the lab's network facts, the format rule they follow, and the Flux, Nix and OpenTofu code that reads them.
---

Two JSON files are the single source of truth for the lab's network facts: addresses, subnets, API server endpoints and BGP ASNs. Flux, Nix and OpenTofu read each fact from these files, so one change reaches every layer. Name the key and the file on a page or in code, and do not copy the value. [Network](../platform/network.md) says what the networks are.

## Files

| File | Holds | Keys |
| --- | --- | --- |
| `clusters/<site>/config/cluster-topology.json` | One cluster: its node, pod, service and load-balancer ranges, API server, gateway router and BGP ASNs | `CLUSTER_NAME`, `API_SERVER_*`, `ROUTER_IP`, `*_CIDR`, `LB_RANGE`, `CLUSTER_DNS`, `BGP_*_ASN` |
| `clusters/folly/config/lab-topology.json` | The folly lab: the Lab Net and `future` ranges, and the addresses of lab hosts and Windows desktops | `LAB_CIDR`, `FUTURE_CIDR`, `<HOST>_IP` |

Print the keys and values of a file with `jq .data <file>`.

## Format

Each file is a Kubernetes ConfigMap in the `flux-system` namespace, written as JSON, which is also valid YAML. Flux applies the file as it is. Its `data` is a flat map of string keys to string values, because Flux substitution accepts only strings. A list is a comma-separated string, as in `CLUSTER_DNS`, and a number is a quoted string, as in `API_SERVER_PORT`. Each reader parses these values back.

## Readers

| Reader | How it reads the files | Where |
| --- | --- | --- |
| Flux | The `config` Flux Kustomization applies each file as a ConfigMap. Other Flux Kustomizations replace `${KEY}` in their manifests with values from it, through `postBuild.substituteFrom`. | `clusters/<site>/config/kustomization.yaml` and `clusters/<site>/flux-system/` |
| Nix | `builtins.fromJSON` at evaluation | `nix/services/k8s/networks.nix` for the clusters, and `nix/lib/lab.nix` for the lab |
| OpenTofu | The `cluster-topology` module returns the `data` of one file, selected by its `site` and `config_map` inputs | `terraform/modules/cluster-topology/` |
| `update-kubeconfigs` | `jq` reads each `API_SERVER_IP` from the repo checkout that the script is linked from. With no checkout, it fetches the file from `main` on GitHub. | `dotfiles/.local/bin/update-kubeconfigs` |

On folly, only the `monitoring` and `storage` Flux Kustomizations substitute from `lab-topology`. To find the OpenTofu roots that read a file, run `git grep -l modules/cluster-topology -- terraform clusters`.

`terraform/network/tailscale/fleet.tf.json` follows the same pattern for naming facts: the tailnet name and the public DNS zone. The Tailscale root loads it as `local.fleet`, and `nix/lib/fleet.nix` reads it.

## Checks

| Check | What it enforces | Where it runs |
| --- | --- | --- |
| Topology contract | Each `cluster-topology.json` is the `flux-system/cluster-topology` ConfigMap, has flat string data and every required key, holds valid addresses, CIDRs, port and ASNs, and does not overlap the other cluster | `.github/workflows/topology-contract.yml`, with the conftest policy `.github/policy/cluster-topology.rego` |
| Lab address preconditions | Each lab host address in `lab-topology.json` matches its reservation in `terraform/network/unifi/folly/clients.yaml` | The plan of `terraform/network/unifi/folly` |
| Nix evaluation | Every host still evaluates with the new values | `nix-ci.yaml`, on a change to any topology file |

The topology contract does not check `lab-topology.json`.

## Rules

- Keep every `data` value a string. Kubernetes rejects a ConfigMap with any other value, and Flux substitutes only strings.
- A change to a topology file gets no Atlantis autoplan, because `ATLANTIS_AUTOPLAN_FILE_LIST` matches no `.json` file. Plan and apply each root that reads the file, as [OpenTofu and Atlantis](../platform/opentofu.md#rules) describes.
- Change a lab host address in `lab-topology.json` and `clients.yaml` in the same pull request, or the precondition fails the plan.
- Some files hold a literal copy of a topology value: the FRR files, `policy.hujson` and the addresses pinned in app manifests. Change them in the same pull request, as the [Network rules](../platform/network.md#rules) describe.
- Put a setting that is not a network fact, such as a time zone or a DNS zone for Apps, in `cluster-settings`: `clusters/base/cluster-settings.yaml`, patched by `clusters/<site>/config/cluster-settings.yaml`.
- `CATHY_IP` and `PBX_SIP_VIP` are addresses in folly's `cluster-settings`, for the [PBX](../apps/pbx.md). `CATHY_IP` is the office phone on Management, which neither topology file covers, and the folly `apps` Flux Kustomization does not substitute from `lab-topology`. `terraform/network/unifi/folly/voip.tf` checks `CATHY_IP` against `clients.yaml`.

## Related

- [Network](../platform/network.md)
- [Kubernetes](../platform/kubernetes.md)
- [NixOS](../platform/nixos.md)
- [OpenTofu and Atlantis](../platform/opentofu.md)
