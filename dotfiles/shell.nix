{ pkgs }:
with pkgs;
mkShell {
  buildInputs = [
    nixfmt-rfc-style
    shellcheck
  ];

  shellHook = ''
    ${figlet}/bin/figlet -f slant "greetings" |
    ${cowsay}/bin/cowsay -n -f moose |
    ${dotacat}/bin/dotacat
    echo -e "Welcome to my dotfiles repo! This is a nix-shell environment.
    It contains all the tools you need to work with this repo.\n" | ${dotacat}/bin/dotacat

    echo "To get started, run 'nix build' to build the full package set." | ${dotacat}/bin/dotacat
  '';
}
