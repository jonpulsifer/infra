# blinkypi0: same board family as radiopi0 (Pi Zero W, armv6l), same cross-build
# story -- but the physical device is currently unplugged, so this config is
# derived from docs/pages/Hosts___blinkypi0.md and mirrors radiopi0 rather than
# being verified against live hardware.
{ ... }:
{
  imports = [ ../profiles/pi-zero.nix ];
}
