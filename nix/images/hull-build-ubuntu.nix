# The build variant of the Ubuntu hull: same boot plumbing as hull-ubuntu,
# a build script in place of the ARC runner. See hull-ubuntu.nix's `variant`
# parameter for what actually differs.
{ callPackage }:
callPackage ./hull-ubuntu.nix { variant = "build"; }
