final: prev: {
  # cloudevents = final.callPackage ./cloudevents.nix { };
  # ddnsb0t = final.callPackage ./ddnsb0t.nix { };
  flarectl = final.callPackage ./flarectl.nix { };
  # k8sgpt = final.callPackage ./k8sgpt.nix { };
  kubectl = final.callPackage ./kubectl.nix { };
  pixlet = final.callPackage ./pixlet.nix { };
  shell-utils = final.callPackage ./shell-utils { };
  # sonos = final.callPackage ./sonos.nix { };
}
