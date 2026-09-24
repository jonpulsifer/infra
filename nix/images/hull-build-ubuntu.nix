# The Ubuntu hull with an image build script in place of the ARC runner.
{ callPackage }:
callPackage ./hull-ubuntu.nix { variant = "build"; }
