{
  pkgs ? import <nixpkgs> { },
}:
with pkgs;
mkShell {
  buildInputs = [
    nixfmt-rfc-style
    shellcheck
  ];

  shellHook = ''
    ${pkgs.figlet}/bin/figlet -f slant "greetings" |
    ${pkgs.cowsay}/bin/cowsay -n -f moose |
    ${pkgs.lolcat}/bin/lolcat -a -d 1
    echo -e "Welcome to my dotfiles repo! This is a nix-shell environment.
    It contains all the tools you need to work with this repo.\n" | ${pkgs.lolcat}/bin/lolcat -a -d 2

    echo "To get started, run 'nix build' to build the full package set." | ${pkgs.lolcat}/bin/lolcat -a -d 2
  '';
}
