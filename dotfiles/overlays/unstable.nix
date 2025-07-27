# Unstable overlay - Development tools and packages that update frequently
# These packages can cause rebuilds but are isolated from stable packages
final: prev: {
  # Development and CLI tools
  kubectl = final.callPackage ../pkgs/kubectl.nix { };
  
  # Commented out packages from original overlay - uncomment as needed
  # cloudevents = final.callPackage ../pkgs/cloudevents.nix { };
  # ddnsb0t = final.callPackage ../pkgs/ddnsb0t.nix { };
  # flarectl = final.callPackage ../pkgs/flarectl.nix { };
  # pixlet = final.callPackage ../pkgs/pixlet.nix { };
  # sonos = final.callPackage ../pkgs/sonos.nix { };
}