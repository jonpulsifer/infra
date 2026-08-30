icon:: 🔑
tags:: runbook

- Every context in `~/.kube/config` authenticates with a **short-lived token minted on demand**, not with a stored credential. `kubectl` runs `kube-jit-token`, which asks the control plane for an eight-hour ServiceAccount token and hands it back; kubectl caches it until it is nearly expired and then asks again. Nothing long-lived is written to the workstation.
- ## Get a kubeconfig
	- ```bash
	  update-kubeconfigs
	  ```
	- It fetches each cluster's CA and API server address over ssh, points the context at the JIT credential, and keeps the fetched `cluster-admin` certificate beside it as `<cluster>-breakglass`. It backs up the existing file first.
	- The identity behind the token is the `operator` ServiceAccount in `kube-system`, declared in `clusters/base/operator-rbac.yaml` and bound to the `cluster-admin` ClusterRole on both clusters.
- ## When the token path is broken
	- ```bash
	  kubectl --context folly --user folly-breakglass get nodes
	  ```
	- The break-glass user is the `O=system:masters` certificate the control plane issues to itself. X.509 is a separate authenticator from the token chain, so it keeps working when the ServiceAccount, its binding, or the TokenRequest path is what is broken. It is not the daily driver because the apiserver cannot revoke a certificate and RBAC cannot bound `system:masters`.
	- If that certificate has expired too, `update-kubeconfigs` fetches a fresh one — certmgr renews the host's copy 72 hours before it lapses, checking hourly.
	- The last resort is the control plane itself: `ssh optiplex.lolwtf.ca` (folly) or `ssh retrofit.lolwtf.ca` (offsite), then `sudo kubectl`.
- ## Withdraw access
	- ```bash
	  kubectl delete clusterrolebinding operator
	  ```
	- Tokens already minted stay valid for the rest of their eight hours, but authorization is checked per request, so the binding going away stops them. Deleting the ServiceAccount invalidates them outright — `--service-account-lookup` defaults on, so the apiserver checks that the account still exists on every request.
	- This is the thing the old arrangement could not do. A `system:masters` certificate is unrevokable: the apiserver supports no CRL and no OCSP, so the only way to withdraw one is to rotate the cluster CA and every leaf under it.
- ## How it is put together
	- `dotfiles/.local/bin/kube-jit-token` is the credential plugin. It takes a control-plane host, a ServiceAccount, a namespace and a TTL, mints through `kubectl create token` over ssh, and prints an `ExecCredential`. The apiserver refuses a TTL under ten minutes.
	- The credential that actually reaches the cluster is **ssh**, which is already the operator's root of trust and is already revocable. A stolen laptop with no ssh key mints nothing.
	- `clusters/base/operator-rbac.yaml` is the identity, applied to both clusters through [[Architecture/GitOps]]. See [[Architecture/Secrets and PKI]] for the certificate chain the break-glass user rides on.
