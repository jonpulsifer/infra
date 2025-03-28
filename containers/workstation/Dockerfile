FROM nixos/nix:2.27.1
LABEL maintainer=jonathan@pulsifer.ca \
      ca.lolwtf.os=linux \
      ca.lolwtf.distro=nixos

RUN nix --extra-experimental-features 'nix-command flakes' run nixpkgs#git clone https://github.com/jonpulsifer/dotfiles.git .dotfiles
WORKDIR /.dotfiles

RUN nix --extra-experimental-features 'nix-command flakes' run
