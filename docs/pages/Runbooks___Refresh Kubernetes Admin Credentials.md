icon:: 🔑
tags:: runbook

- The operator's `cluster-admin` certificate is the one credential in the estate with no automation carrying it to where it is used. certmgr renews the control plane's own copy on the host; nothing copies that into `~/.kube/config`, so the operator's copy lapses every 30 days and `kubectl` stops working with an expired-certificate error.
- ## Refresh it
	- ```bash
	  mise run k8s:refresh-admin              # every cluster that has something newer
	  mise run k8s:refresh-admin -- folly     # one cluster; mise needs the `--` to pass an argument
	  ```
	- It backs up `~/.kube/config` first, reads `cluster-admin.pem` and its key off each cluster's control-plane node over ssh, and writes them in with `--embed-certs`. It reports one line per cluster.
	- `unchanged` means the installed copy is already the current generation — either it was refreshed already, or certmgr has not reached its renewal window. Nothing is written. This is the case worth understanding: reinstalling the same certificate would look like success and buy nothing.
	- `REFUSED` means the key on the host does not match its certificate, and `FAILED` means the new credential did not authenticate. Neither leaves a broken kubeconfig — the backup is beside the original, named with the time it was taken.
- ## When to run it
	- When `kubectl` starts answering with an expired-certificate error, or ahead of that. `mise run alerts` shows `KubeClientCertificateExpiration` on the affected cluster for the four days between the alert's 7-day threshold and certmgr's 3-day renewal window, on every cycle — that alert is about the cluster's own leaves, not the kubeconfig, but it lands in the same week and is a serviceable reminder.
	- Check what is installed without changing anything:
		- ```bash
		  kubectl config view --raw -o json \
		    | jq -r '.users[] | select(.user["client-certificate-data"]) | .name + " " + .user["client-certificate-data"]' \
		    | while read -r name data; do
		        printf '%s ' "$name"
		        echo "$data" | base64 -d | openssl x509 -noout -enddate
		      done
		  ```
- ## Why it is not automatic
	- certmgr renews on the host 72 hours before a leaf lapses and checks hourly, so a cluster's own certificates rotate without anyone present. Carrying one into a workstation's kubeconfig needs `sudo` on the control plane and write access to a file outside the repo, which is an operator action rather than a cluster one. The script is the procedure written down, not a service.
	- The renewal window matters when both halves are near their expiry: running before certmgr has renewed copies the same expiring certificate. The script refuses that case rather than reporting it as done.
- ## Where the certificates come from
	- `nix/services/k8s/` declares certmgr and the cfssl specs behind it; the leaves live at `/var/lib/kubernetes/secrets/` on each control plane, owned by root. See [[Architecture/Secrets and PKI]] for the wider chain and [[Fleet]] for which host is which cluster's control plane.
