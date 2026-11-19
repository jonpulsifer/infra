{ callPackage }:
(callPackage ./package.nix { }).overrideAttrs (old: {
  pname = "fleet-seed";
  subPackages = [ "cmd/fleet-seed" ];
  env = (old.env or { }) // {
    CGO_ENABLED = "0";
  };
  ldflags = [
    "-s"
    "-w"
  ];
  doCheck = false;
  meta = old.meta // {
    description = "Fetches a node's seed from fleetd on its first boot";
    mainProgram = "fleet-seed";
  };
})
