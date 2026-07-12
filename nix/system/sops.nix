{ inputs, ... }:
{
  imports = [ inputs.sops-nix.nixosModules.sops ];

  # Decrypts with the host's own SSH host key (sops-nix's default
  # age.sshKeyPaths) rather than distributing the fleet's shared cluster-secrets
  # age key onto bare hosts -- a compromised host only exposes secrets scoped
  # to that host, not every cluster secret in the repo.
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
}
