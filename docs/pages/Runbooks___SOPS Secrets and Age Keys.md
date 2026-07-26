tags:: runbook, sops, secrets

- Use this when working with sops-nix-encrypted per-host secrets in this repo: adding a new SOPS-managed host, generating or rotating a harmonia binary-cache keypair, decrypting/re-encrypting a `nix/secrets/*.sops.yaml`, or chasing decryption errors. The flow that bites first-timers hardest is the **two-stage recipient setup** — the operator's age key is the only recipient until the host has booted once, then the host's own `ssh-to-age` recipient gets added; the section below walks through it.
- # Where the keys live
	- The operator's age keypair — the one that encrypts and decrypts on the dev machine — sits at `~/.config/age/keys.txt` (mode 600), not at the sops binary's default of `~/.config/sops/age/keys.txt`. The `age` binary's own config dir happens to be where this repo's setup landed; the sops binary's default never has. If `sops -d` errors with `failed to load age identities`, the key is either missing or `SOPS_AGE_KEY_FILE` isn't pointing at it.
	- The plaintext `AGE-SECRET-KEY-1A...` line is in 1Password (homelab vault, item **"sops homelab age key"**) as the recovery path for a wiped dev machine. To restore, run:
		- ```bash
		  op item get "sops homelab age key" --vault homelab --fields notesPlain
		  # or fetch the secret and write it:
		  mkdir -p ~/.config/age
		  install -m 600 <(op item get "sops homelab age key" --vault homelab --fields notesPlain) ~/.config/age/keys.txt
		  ```
	- Each host's own decryption key is **derived from its ed25519 SSH host key** via `ssh-to-age`, NOT a separately-stored file. `nix/system/sops.nix` tells sops-nix to use `sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ]` — a compromised host only exposes secrets scoped to itself, no shared fleet-wide age key. The matching recipient is listed in `nix/secrets/<host>.sops.yaml` once the host has booted (see the two-stage flow below).
	- The harmonia binary-cache keypair is a Nix-format `nix-store --generate-binary-cache-key` pair. Private half goes into the host's sops file under `harmonia-cache-key`; public half is committed in the clear at `nix/secrets/<host>-harmonia-cache.pub` and is what clients pin in their `nix.settings.trusted-public-keys`. 1Password homelab vault item **"<host> harmonia cache key"** holds the plaintext copy as a backup.
- # Decrypt, edit, re-encrypt
	- ```bash
	  # Decrypt a sops file to stdout
	  SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -d nix/secrets/<host>.sops.yaml

	  # Edit in place (decrypts to a temp file, re-encrypts on save)
	  SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops nix/secrets/<host>.sops.yaml

	  # Encrypt an existing plaintext file in place
	  SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -e -i nix/secrets/<host>.sops.yaml
	  ```
	- If `sops` isn't on `PATH`, the nix dev shell is one wrapper away: `nix develop -c sops -d nix/secrets/<host>.sops.yaml`. `op` and `age` are normal binaries via `mise`; no special nix shell needed.
- # Add a new SOPS-managed host (the two-stage flow)
	- ## Stage 1: provision the encrypted file with the operator key only
		- Add a `creation_rule` to `.sops.yaml` keyed to the new file's path. The new rule's recipient list is just the operator's age public key — the host's ed25519 doesn't exist yet, so it can't be a recipient:
		- ```yaml
		  - path_regex: nix/secrets/<host>\.sops\.ya?ml
		    key_groups:
		      - age:
		          - age1lpfxcn6qwrgtxzymzcxqu20cppsrhmgcpma59sc8ahq9t0w67d3sj8e3e6
		  ```
		- Generate the secret material (harmonia keypair example):
		- ```bash
		  nix-store --generate-binary-cache-key <host>.lolwtf.ca-1 \
		    /tmp/<host>-cache.priv /tmp/<host>-cache.pub
		  ```
		- Write the plaintext file at `nix/secrets/<host>.sops.yaml` with the secret value under its key (e.g. `harmonia-cache-key`), then encrypt it. The `path_regex` matches on the file's path, so the rule applies:
		- ```bash
		  SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -e -i nix/secrets/<host>.sops.yaml
		  ```
		- Commit the encrypted file plus the in-the-clear `.pub`. The `*.pub` gitignore (in `~/.config/git/ignore` globally) blocks the public key — override per-file: `git add -f nix/secrets/<host>-harmonia-cache.pub`.
		- Wire the host's flake entry: `imports = [ ./nix/system/sops.nix ]; sops.defaultSopsFile = ./nix/secrets/<host>.sops.yaml; sops.secrets."harmonia-cache-key" = { };`. The host's first activation will succeed against the operator-only recipient set; sops-nix derives its age key from the host's just-generated ed25519 and stores the path under `/run/secrets/<key>`.
	- ## Stage 2: add the host's age recipient after the first successful boot
		- Once the host is up and has its ed25519 host key, derive the age pubkey and add it as a second recipient:
		- ```bash
		  ssh <host>.lolwtf.ca cat /etc/ssh/ssh_host_ed25519_key.pub | ssh-to-age
		  # returns an age1... string

		  SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -r --add-age <pubkey> nix/secrets/<host>.sops.yaml
		  ```
		- Commit the re-encrypted file. From here, sops-nix on the host decrypts on its own; the operator key is still in the recipient list (keeps the dev-machine path working) but isn't load-bearing for activation.
		- The two-stage gap is the price of not distributing a fleet-wide age key onto every host. Skipping it (adding the host key speculatively) is a hard fail — `ssh-to-age` against a not-yet-generated key returns nothing, and the host activation errors with "no matching recipient".
- # Decryption failure triage
	- ## "failed to load age identities"
		- `SOPS_AGE_KEY_FILE` is unset or the file at that path is wrong. Either `export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt` or symlink: `mkdir -p ~/.config/sops/age && ln -sf ~/.config/age/keys.txt ~/.config/sops/age/keys.txt`.
		- Verify the file is `mode 0600` — `sops` will refuse anything more permissive. Wrong perms: `chmod 600 ~/.config/age/keys.txt`.
	- ## "no matching creation rules found"
		- The sops file's path doesn't match any `path_regex` in `.sops.yaml`, OR the file was originally created against a different rule (encryption time matters; the current `.sops.yaml` only governs new files). Recreate the file from plaintext against the current rule.
	- ## "Failed to get the data key required to decrypt"
		- Your key isn't a recipient of this file. List recipients with `sops -d --show-age-keys <file>` (prints recipient fingerprints, not secrets) and confirm yours is there. If it's not, the file was created against a different rule or before your key was added.
	- ## sops-nix activation error on a host
		- "no matching recipient" or "decryption failed" on `nixos-rebuild switch`: the host's ed25519-derived age pubkey isn't in the sops file. Run stage 2 above.
	- ## "kms key creation failed" / age decrypt errors after `sops` upgrade
		- A pinned sops version may not support the latest age format. Run `sops --version` on the dev machine; if it's drifted, `nix develop` pins it to a known-good version.
- # Rotate the operator age key
	- This is the "I need to re-encrypt every `.sops.yaml`" operation. Touch lightly.
	- Generate a new keypair: `age-keygen -o ~/.config/age/keys.new.txt` (output prints the public half; chmod 600 the file).
	- For every existing sops file, add the new public key as a recipient and remove the old one: `sops -r --add-age <new pubkey> --remove-age <old pubkey> nix/secrets/<host>.sops.yaml`. Use `sops -d --show-age-keys <file>` to enumerate current recipients.
	- Replace `~/.config/age/keys.txt` with `~/.config/age/keys.new.txt` and update the 1Password item "sops homelab age key" with the new private half.
	- The old key should be kept in 1Password (disabled/revoked but recoverable) for at least one full deploy cycle, in case a host's first boot is still mid-flight with the old key as the only working recipient.
- # 1Password discipline
	- New long-lived operational secret (operator key, harmonia cache key, cloud account key): commit a 1Password item in the same PR, in the **homelab** vault, with the title `<thing> (<host>, if scoped)`. Examples that already exist: "sops homelab age key", "forge harmonia cache key", "unifi-terraform", "unifi-terraform (offsite)", "hermes api server key", "GitHub - rowbutt".
	- Per-host short-lived tokens (session, OAuth code, Tailscale auth) don't go in 1Password — they live only in the relevant `*.sops.yaml`.
	- If a secret is in 1Password but not findable by `op item list --vault homelab | grep <name>`, it's in the wrong vault or the title drifted. Search the live vault list before assuming it's missing.
