{ inputs, ... }:
{
  imports = [ inputs.sops-nix.nixosModules.sops ];

  # Decrypt with the host's own SSH host key, never the shared cluster age key, so a
  # compromised host exposes only the secrets its own file seals. Keep that file to what the
  # host loads: a value sealed for later is a value the host key opens.
  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
}
