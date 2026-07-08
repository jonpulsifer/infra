type:: host
role:: cloud VM
vendor:: Google Cloud
model:: GCE e2-micro (free tier)
serial:: n/a (virtual)
cpu:: 2 shared vCPU
ram:: 1 GB
storage:: 16 GB pd-standard
os:: NixOS

- Free-tier GCE VM in the `homelab-ng` project, built from the repo's NixOS GCE image (`terraform/gcp/projects/homelab-ng/compute.tf`).
- Not reachable from the LAN by name; no `oldboy.lolwtf.ca` or tailnet record as of 2026-07 — specs above are from Terraform, not a live login.
- Config: `nix/hosts/oldboy.nix`, tagged `gcp`. See [[Fleet]] for the full inventory.
