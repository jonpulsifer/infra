# dotfiles

hi, these are my [dotfiles](https://dotfiles.github.io), buyer beware

![glamanonymous](/glamanon.jpeg)

ty @amcleodca, @burke, @dantecatalfamo, and @malob

## installation

Install Nix

1. `curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install`

### macos

1. `nix build github:jonpulsifer/dotfiles#darwinConfigurations.$(hostname).system`
1. `./result/sw/bin/darwin-rebuild switch --flake .`

### nix on linux

1. `nix run`
