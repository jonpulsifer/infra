---
name: sops-secrets
description: >-
  Work with SOPS files and the age keys that encrypt them, in nix/secrets/ and
  clusters/. Use when adding a SOPS-managed host, creating or rotating a
  harmonia cache key, changing an encrypted value, or fixing a "failed to load
  age identities", "no matching creation rules" or decryption error.
metadata:
  runbook: docs/runbooks/manage-sops-secrets.md
  wiki: https://wiki.lolwtf.ca/runbooks/manage-sops-secrets/
---

# SOPS secrets

The procedure is `docs/runbooks/manage-sops-secrets.md`, and the platform page
is `docs/platform/secrets.md`. These notes cover what an agent needs beyond
them.

## Notes

- Set `SOPS_AGE_KEY_FILE=~/.config/age/keys.txt`, because `sops` looks
  elsewhere by default. If the file is missing, tell the owner; the runbook
  restores it from 1Password.
- `.sops.yaml` holds the creation rules. A file's path picks its rule, and the
  recipients are fixed when the file is encrypted.
- Never print a decrypted value. The transcript, the PR and the public repo
  can carry it. SOPS leaves key names in the clear, so read them from the
  encrypted file.
- To change one value, pipe it as a JSON string into
  `sops set --value-stdin <file> <path>`, which prints nothing. In
  `nix/secrets/`, `<path>` is `'["<key>"]'`. In a `clusters/` Secret, it is
  `'["stringData"]["<key>"]'`, or `'["data"]["<key>"]'` with a base64 value.
  A top-level key in a `clusters/` file is stored in cleartext. Before
  `git add`, make sure the new value starts with `ENC[`.
- A new host's file has only the operator key as a recipient until the host
  boots once and `ssh-to-age` derives the host's recipient. Its first
  configuration declares no secret it needs to boot.
- A new SSH host key needs a new recipient before the host can decrypt its
  file.
- sops-nix on a host decrypts with that host's SSH host key
  (`nix/system/sops.nix`). Flux decrypts `clusters/` files with the `sops-age`
  Secret on each cluster.
- A long-lived secret, such as a harmonia (Nix binary cache) key or a cloud
  account key, also gets a 1Password item in the homelab vault. Create the
  item in the same change. Title it `<host> <thing>` when one host uses it,
  such as `forge harmonia cache key`, as `docs/platform/secrets.md` says. A
  short-lived token lives only in its `*.sops.yaml`.
