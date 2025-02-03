{ pkgs ? import <nixpkgs> { } }:
with pkgs;
mkShell {
  buildInputs = [
    python3
    python3Packages.pip
    python3Packages.pyserial
  ];

  shellHook = ''
    ${pkgs.figlet}/bin/figlet -f slant "RPi"
    echo -e "Welcome to the infra repo! This is a nix-shell environment.
    It contains all the tools you need to work with the rpi.\n"

    echo "To get started, run 'TODO: lol' to run the thing."
  '';
}
