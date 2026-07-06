# nixos/nix devcontainer; the nix daemon and single-user nix store require root.
# trivy:ignore:AVD-DS-0002
FROM nixos/nix:2.34.8
LABEL maintainer=jonathan@pulsifer.ca \
      ca.lolwtf.os=linux \
      ca.lolwtf.distro=nixos

RUN nix --extra-experimental-features 'nix-command flakes' run nixpkgs#git clone https://github.com/jonpulsifer/dotfiles.git .dotfiles
WORKDIR /.dotfiles

RUN nix --extra-experimental-features 'nix-command flakes' run
