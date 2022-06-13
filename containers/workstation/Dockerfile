FROM nixos/nix:2.9.1
LABEL maintainer=jonathan@pulsifer.ca \
      ca.lolwtf.os=linux \
      ca.lolwtf.distro=nixos \
      ca.lolwtf.release=2.7.0

RUN nix --extra-experimental-features 'nix-command flakes' run nixpkgs#git clone https://github.com/jonpulsifer/dotfiles.git .dotfiles
WORKDIR /.dotfiles

RUN nix --extra-experimental-features 'nix-command flakes' run
