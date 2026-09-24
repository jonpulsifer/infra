# bluenose

OpenTofu root for `bluenose`, the GCP project that kthx runs in and deploys built apps to by default. See [kthx security](https://wiki.lolwtf.ca/apps/kthx/security/) on the wiki.

A vessel is a boundary that kthx deploys into, and `bluenose` is the home vessel. This root owns the boundary, and kthx owns what it deploys inside it. Build artifacts and signing keys are in `terraform/gcp/projects/trusted-builds/`.

`vessel.tf` calls the `spindrift-vessel` and `vessel-network` modules for the parts that every vessel project has. The subnet comes from `config/vessel-topology.json`. The other files hold what only the home vessel has: service accounts and their federation, buckets, and the Firebase project. `storage.tf` also holds the `kthx` bucket, which the kthx server reads as `KTHX_BUCKET`.

kthx proposes Terraform for unmet prerequisites into `services.tf`, `iam.tf` and `storage.tf`, and reads those files to skip what they already declare. Keep `vessel_services` in `services.tf` and `spindrift_project_roles` in `iam.tf`. A new vessel project needs a backend, providers, those two lists and the module call.

## Develop

```bash
tofu -chdir=terraform/gcp/projects/bluenose init -backend=false
tofu -chdir=terraform/gcp/projects/bluenose validate
TF_DIR=terraform/gcp/projects/bluenose mise run tf:plan
```

A local plan impersonates `terraform@homelab-ng.iam.gserviceaccount.com`, so your Google account needs Service Account Token Creator on it.

## Deploy

Atlantis plans this root on a pull request that changes it. Comment `atlantis apply` to apply the plan, and a successful apply merges the pull request. State is in `gs://homelab-ng/terraform/bluenose`.

After an apply that changes the network, copy the `vessel_network_block` output into the kthx installation manifest.
