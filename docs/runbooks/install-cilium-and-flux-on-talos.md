---
title: Install Cilium and Flux on Talos
description: Write the kubeconfig context of a new Talos cluster, install Cilium with its pod IP pool and BGP peering, and bootstrap Flux.
---

Use this runbook during [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md), after the nodes register `NotReady`. A new cluster has no pod network and no Flux, so Flux cannot apply `clusters/<site>/networking/` itself. CoreDNS forwards to `ROUTER_IP`, and the gateway routes replies to pods only over Cilium's BGP session. Flux resolves no source until BGP peers. Flux adopts each object that this runbook creates.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because Flux needs the pod network, DNS and the BGP route before it runs.

## Before you start

- Run `mise run devshell`, and set `SOPS_AGE_KEY_FILE` to the operator key.
- The `talosctl` context `<site>` reaches the control plane.

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of the cutover branch. `<cp>` is `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`.

## Write the kubeconfig

The providers of `clusters/<site>/bootstrap/` use the kubeconfig context `<site>`. `talosctl` names its context `admin@<site>`, so rename it.

1. Back up the kubeconfig.

   ```bash
   cp ~/.kube/config ~/.kube/config.bak
   ```

2. Write the cluster's admin context.

   ```bash
   talosctl --context <site> -n <cp> kubeconfig --force-context-name <site> --force
   ```

3. Delete the old cluster's context, and rename the new one.

   ```bash
   kubectl config delete-context <site>
   kubectl config rename-context admin@<site> <site>
   ```

4. Make sure that the context reaches the new cluster.

   ```bash
   kubectl --context <site> get nodes
   ```

   Result: Each node, `NotReady`.

## Install Cilium

Cilium's values need the Prometheus Operator CRDs, and its chart renders the `cilium` GatewayClass only when the Gateway API CRDs exist.

1. Install the Prometheus Operator CRDs.

   ```bash
   helm --kube-context <site> install prometheus-operator-crds prometheus-operator-crds \
     --repo https://prometheus-community.github.io/helm-charts \
     --version "$(yq '.spec.chart.spec.version' clusters/base/monitoring-crds/prometheus-operator-crds.yaml)" \
     -n flux-system --create-namespace --set 'crds.annotations.helm\.sh/resource-policy=keep'
   ```

2. Install the Gateway API CRDs at the tag that the `gateway-api` GitRepository pins.

   ```bash
   kubectl --context <site> create -k \
     "https://github.com/kubernetes-sigs/gateway-api/config/crd/experimental?ref=$(yq '.spec.ref.tag' clusters/<site>/networking/git-repository-gateway-api.yaml)"
   kubectl --context <site> wait --for condition=established crd/gatewayclasses.gateway.networking.k8s.io --timeout 5m
   ```

3. Render `clusters/<site>/networking` as Flux does. The decrypted values stay in the shell and on `/dev/shm`.

   ```bash
   cd <checkout>; set -a
   eval "$(jq -r '.data | to_entries[] | "\(.key)=\(.value | @sh)"' clusters/<site>/config/cluster-topology.json)"
   eval "$(yq -o shell '.data' clusters/base/cluster-settings.yaml)"
   eval "$(yq -o shell '.data' clusters/<site>/config/cluster-settings.yaml)"
   eval "$(sops -d --extract '["stringData"]' clusters/<site>/config/cluster-secrets.sops.yaml | yq -o shell)"
   set +a
   kubectl kustomize clusters/<site>/networking | flux envsubst --strict > /dev/shm/networking.yaml
   ```

4. Install Cilium.

   ```bash
   yq 'select(.kind == "HelmRelease" and .metadata.name == "cilium") | .spec.values' /dev/shm/networking.yaml \
     | helm --kube-context <site> install cilium oci://quay.io/cilium/charts/cilium -n kube-system -f - \
         --version "$(yq '.spec.ref.tag' clusters/<site>/networking/cilium/oci-repository.yaml)"
   ```

5. Create the pod IP pool.

   ```bash
   kubectl --context <site> wait --for condition=established crd/ciliumpodippools.cilium.io --timeout 5m
   yq 'select(.kind == "CiliumPodIPPool")' /dev/shm/networking.yaml | kubectl --context <site> create -f -
   ```

   Result: Each node is `Ready` within a few minutes.

6. Create the BGP objects and the load balancer IP pool, then delete the render.

   ```bash
   yq 'select(.kind == "CiliumBGPClusterConfig" or .kind == "CiliumBGPPeerConfig" or .kind == "CiliumBGPAdvertisement" or .kind == "CiliumLoadBalancerIPPool")' \
     /dev/shm/networking.yaml | kubectl --context <site> create -f -
   rm /dev/shm/networking.yaml
   ```

7. Make sure that the BGP session to the gateway is up.

   ```bash
   kubectl --context <site> -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg shell -- bgp/peers
   ```

   Result: Each peer shows `established`.

## Install Flux

1. Create the Secret `sops-age` with the operator key. Flux decrypts with it, and git does not declare it.

   ```bash
   kubectl --context <site> -n flux-system create secret generic sops-age --from-file=age.agekey="$SOPS_AGE_KEY_FILE"
   ```

   Result: `secret/sops-age created`.

2. Apply the bootstrap root. It installs CoreDNS and Flux. Talos labels the nodes, so `node-labels.tf` only forgets the old labels.

   ```bash
   tofu -chdir=clusters/<site>/bootstrap init
   tofu -chdir=clusters/<site>/bootstrap apply
   ```

3. Make sure that Flux applies `main`.

   ```bash
   flux --context <site> get kustomizations
   flux --context <site> get helmreleases -A
   ```

   Result: Each row is `True`. Each Cilium pod restarts once when Flux adopts the release.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The bootstrap root times out, or fails TLS to the API server. | The context `<site>` names the old cluster, and the new one is `admin@<site>`. | Do [Write the kubeconfig](#write-the-kubeconfig) again. |
| CoreDNS logs `i/o timeout` to `ROUTER_IP`, or the FluxInstance shows `server misbehaving`. | Cilium's BGP session is not established, so the gateway's replies to pods have no route. | Do steps 6 and 7 of [Install Cilium](#install-cilium). |
| A Flux Kustomization fails with `secret "sops-age" not found`. | The Secret was not created. | Do step 1 of [Install Flux](#install-flux). |
| The `cilium` HelmRelease shows `MissingRollbackTarget`. | The upgrade timed out before both operator replicas had a node. | Run `flux --context <site> reconcile hr cilium -n kube-system --reset --force`. |
| The bootstrap root plans changes to `kubernetes_labels.nodes`. | `node-labels.tf` still declares the resource. | Replace it with a `removed` block, as `clusters/folly/bootstrap/node-labels.tf` does. |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Verify a Talos cluster](verify-a-talos-cluster.md)
- [Kubernetes](../platform/kubernetes.md)
