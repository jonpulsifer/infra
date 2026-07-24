# systemd

Raw systemd unit files for a "cloudlab" host: a GCE VM running containers under
Docker with the gVisor (`runsc`) runtime, on a shared `cloudlab` Docker network
with static addressing.

`cloudlab.service` is the parent unit; the per-service units (`nginx`,
`coredns`, `mysql`, `vault`, `asterisk`, `wishlist`, `bullseye`, `datadog`)
declare `PartOf=cloudlab.service` and start after it. Images come from
`gcr.io/trusted-builds/*`, config is read from `/var/cloudlab/services/<name>/`,
and the `.ejson` files hold EJSON-encrypted secrets.

## Status

**Nothing in this repository references this directory.** No Nix module, no
Terraform, no CI workflow, and no other app points at these units. They are not
part of any current deploy path, and the hosts described here are not in
[`flake.nix`](../../flake.nix).

Deleting this directory is a live question — see the repo's open follow-ups.
Until that is settled, this README exists so the directory is not mistaken for
something wired in.
