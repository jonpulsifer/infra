---
title: Manage SOPS secrets
description: Restore the operator age key, edit or add a SOPS file of encrypted secrets, give a NixOS host its own SOPS file, add a harmonia cache key, and rotate the operator key.
---

SOPS encrypts the secrets in the `*.sops.yaml` files under `clusters/` and `nix/secrets/`. The operator key, the owner's age key, is a recipient of every SOPS file. Use this runbook to restore that key, edit or add a secret, give a new host its own SOPS file, add a harmonia cache key, or rotate the key after an exposure.

> [!WARNING]
> [Rotate the operator key](#rotate-the-operator-key) changes live state by hand. It is an exception to the GitOps rule because git does not declare the Flux `sops-age` Secret.

## Before you start

- `mise` installs `sops`, `age`, `op`, `kubectl` and `flux`. Sign in to 1Password with `op`.
- A host procedure needs `nix` and SSH access to the host as `jawn`.
- A rotation needs the `folly` and `offsite` kubectl contexts.
- In each shell, set the key path.

  ```bash
  export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
  ```

## Restore the operator key

1. Write the key from 1Password to the key file.

   ```bash
   mkdir -p ~/.config/age
   install -m 600 <(op item get "sops homelab age key" --vault homelab --fields notesPlain | grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*') ~/.config/age/keys.txt
   ```

2. Make sure that the key is the operator key.

   ```bash
   age-keygen -y ~/.config/age/keys.txt
   ```

   Result: The command prints the `age1` key that each rule in `.sops.yaml` lists first.

## Edit a secret

1. Open the file in your editor. `sops` encrypts it again when you close the editor.

   ```bash
   sops <file>
   ```

## Add a SOPS file

> [!WARNING]
> A plaintext file in git exposes the secret. Encrypt a new file before you run `git add`.

1. Write the file in plaintext at a path that a rule in `.sops.yaml` matches.
2. Encrypt the file in place.

   ```bash
   sops -e -i <file>
   ```

   Result: The secret values start with `ENC[`.

## Add a SOPS file for a host

The SSH host key exists only after the first boot.

### Before the first boot

1. Add this rule to `.sops.yaml`, with the operator recipient from another rule.

   ```yaml
     - path_regex: nix/secrets/<host>\.sops\.ya?ml
       key_groups:
         - age:
             - <operator recipient>
   ```

2. Write the secrets to `nix/secrets/<host>.sops.yaml` as `<key>: <value>` lines.
3. Encrypt the file, as [Add a SOPS file](#add-a-sops-file) describes.

> [!CAUTION]
> If the host configuration declares a secret from the file now, the deploy fails.

4. Commit the file and the rule.

### After the first boot

> [!CAUTION]
> A reinstall makes a new SSH host key. After a reinstall, do these steps again.

1. Get the host recipient.

   ```bash
   ssh <host>.lolwtf.ca cat /etc/ssh/ssh_host_ed25519_key.pub | nix run nixpkgs#ssh-to-age
   ```

   Result: The command prints an `age1` public key.

2. Add the key and a comment to the host rule in `.sops.yaml`.

   ```yaml
             # <host> (ssh-to-age of its ed25519 host key)
             - age1...
   ```

3. Encrypt the file to the recipients of the rule.

   ```bash
   sops updatekeys -y nix/secrets/<host>.sops.yaml
   ```

   Result: The command prints `synced with new keys`.

4. In `nix/hosts/<host>.nix`, add `../system/sops.nix` to `imports`.
5. Add these lines to the file, with one `sops.secrets` line for each key.

   ```nix
   sops.defaultSopsFile = ../secrets/<host>.sops.yaml;
   sops.secrets."<key>" = { };
   ```

6. Commit the changes.
7. Deploy the host, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## Add a harmonia cache key

harmonia, the Nix binary cache server on a build host, signs the store paths it serves with this key.

1. Make a temporary directory.

   ```bash
   dir=$(mktemp -d)
   ```

2. Make the key pair in the directory.

   ```bash
   nix-store --generate-binary-cache-key <host>.lolwtf.ca-1 "$dir/cache.priv" "$dir/cache.pub"
   ```

3. Add the content of `cache.priv` to the host SOPS file as `harmonia-cache-key`.
4. Put the content of `cache.priv` in a new `homelab` item, `<host> harmonia cache key`.
5. Copy `cache.pub` to `nix/secrets/<host>-harmonia-cache.pub`.

> [!NOTE]
> `dotfiles/.config/git/ignore` ignores `*.pub`.

6. Add the public key file to git.

   ```bash
   git add -f nix/secrets/<host>-harmonia-cache.pub
   ```

7. Delete the temporary directory.

   ```bash
   rm -r "$dir"
   ```

## Rotate the operator key

> [!WARNING]
> Old commits stay readable with the old key. Step 11 replaces each exposed value.

1. Make a new key.

   ```bash
   age-keygen -o ~/.config/age/keys.new.txt
   ```

   Result: The command prints `Public key:` and the new public key.

2. In `.sops.yaml`, add the new public key after the old key in each rule.
3. Encrypt every SOPS file to both keys.

   ```bash
   git ls-files 'clusters/*.sops.yaml' 'nix/secrets/*.sops.yaml' | xargs -n1 sops updatekeys -y
   ```

   Result: The command prints `synced with new keys` for each file.

4. Merge the change.
5. Replace the Flux key. Do steps 5 and 6 for `folly`, then for `offsite`.

   ```bash
   kubectl --context <cluster> -n flux-system create secret generic sops-age --from-file=age.agekey="$HOME/.config/age/keys.new.txt" --dry-run=client -o yaml | kubectl --context <cluster> replace -f -
   ```

   Result: The command prints `secret/sops-age replaced`.

6. Reconcile the `config` Flux Kustomization and its source.

   ```bash
   flux --context <cluster> reconcile kustomization config --with-source
   ```

   Result: The command prints `applied revision` and the commit of `main`.

7. Replace your key file.

   ```bash
   mv ~/.config/age/keys.new.txt ~/.config/age/keys.txt
   ```

8. Put the new private key in the 1Password item `sops homelab age key`.
9. In `.sops.yaml`, remove the old key from each rule.
10. Do steps 3 and 4 again.
11. Replace each value in the SOPS files with a new one from its source.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `sops` prints `failed to load age identities`. | `sops` finds no key file. | Set `SOPS_AGE_KEY_FILE`, or restore the operator key. |
| `sops` prints `no identity matched any of the recipients`. | Your key is not a recipient of the file. | Compare `grep recipient: <file>` with the output of `age-keygen -y ~/.config/age/keys.txt`. |
| `sops` prints `no matching creation rules found`. | No rule in `.sops.yaml` matches the path. | Move the file, or add a rule. |
| The host deploy fails in `sops-install-secrets`. | The host recipient is not in the file. | Do [After the first boot](#after-the-first-boot). |
| A Flux Kustomization reports a SOPS decryption error. | The `sops-age` Secret has no key for the file. | Do step 5 of [Rotate the operator key](#rotate-the-operator-key) with `~/.config/age/keys.txt`. |

## Related

- [Secrets](../platform/secrets.md)
- [Add a Kubernetes node](add-a-kubernetes-node.md)
- [PKI](../platform/pki.md)
