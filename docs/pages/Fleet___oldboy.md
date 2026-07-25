type:: host
vendor:: Google Cloud
model:: GCE e2-micro (free tier)
serial:: n/a (virtual)
cpu:: 2 shared vCPU
ram:: 1 GB
gpu:: none
storage:: 16 GB pd-standard
os:: NixOS

- Free-tier GCE VM in the `homelab-ng` project, built from the repo's NixOS GCE image (`terraform/gcp/projects/homelab-ng/compute.tf`).
- The VM is **not currently provisioned** — its Terraform and NixOS config exist but no live instance runs. Specs above are from Terraform, not a live login. Needs to be brought back.
- When provisioned, its `shielded_instance_config` enables GCE secure boot, a vTPM, and integrity monitoring (`terraform/gcp/projects/homelab-ng/compute.tf`). vTPM state is unverified until the VM runs.
- Config: `nix/hosts/oldboy.nix`, tagged `gcp`.
