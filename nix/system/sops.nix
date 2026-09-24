{ inputs, ... }:
{
  imports = [ inputs.sops-nix.nixosModules.sops ];

  # Decrypt with the host's own SSH host key, never the shared cluster age key, so a
  # compromised host exposes only its own secrets.
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
}
