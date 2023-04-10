{ config, pkgs, ... }:
{
  home.packages = with pkgs; [ pixlet bazel-buildtools ];
}
