{
  lib,
  nixosSystem,
  inputs,
}:
let
  clusterNetworks = [
    "folly"
    "offsite"
  ];

  clusterNetwork =
    tags:
    let
      found = lib.findFirst (tag: lib.elem tag clusterNetworks) null tags;
    in
    if found != null then found else throw "k8s host requires tags = [ \"folly\" ] or [ \"offsite\" ]";

  k8sModule =
    name: cfg:
    let
      tags = cfg.tags or [ ];
      network = clusterNetwork tags;
    in
    {
      imports = [ ../profiles/k8s-node.nix ] ++ (cfg.imports or [ ]);

      networking.hostName = name;

      services.k8s = {
        inherit network;
        role = cfg.role or "worker";
      };
    }
    // (cfg.extraConfig or { });
in
{
  mkHost =
    name: cfg:
    let
      system = cfg.system or "x86_64-linux";
      tags = cfg.tags or [ ];
      baseModules = [
        ../system/ssh.nix
        ../system/user.nix
      ];
      modules = if cfg ? modules then cfg.modules else [ (k8sModule name cfg) ];
    in
    nixosSystem {
      inherit system;
      modules = baseModules ++ modules;
      specialArgs = { inherit inputs name tags; };
    };

  mkImage =
    module:
    nixosSystem {
      system = "x86_64-linux";
      modules = [ module ];
      specialArgs = {
        inherit inputs;
        tags = [ ];
        name = "nixos";
      };
    };
}
