# Point kata's Cloud Hypervisor config at a Cloud Hypervisor that exists.
#
# nixpkgs builds kata-runtime with HYPERVISORS=qemu, but that flag does far
# less than it looks like: kata's amd64-options.mk sets CLHCMD unconditionally,
# so the build generates and installs configuration-clh.toml either way.
# HYPERVISORS only constrains which config the configuration.toml symlink
# points at. What nixpkgs does not do is supply a Cloud Hypervisor — it is not
# among the package's inputs, and CLHPATH defaults to $PREFIXDEPS/bin, which
# under Nix is $out/bin. The shipped config therefore names a binary in the
# kata-runtime output that nothing ever puts there.
#
# Rewriting that one path is the whole fix, and it mirrors how the package
# already rewrites its own kernel, image and virtiofsd paths after install.
#
# Deliberately not an override of the CLHPATH makeFlag: the package's
# buildPhase and installPhase interpolate `${toString makeFlags}` through a
# `rec` self-reference, which is fixed at the original evaluation, so an
# overrideAttrs on makeFlags alone would never reach the make command line.
#
# --replace-fail is the canary. If nixpkgs ever wires CLHPATH itself, the
# placeholder disappears, this build fails loudly, and the overlay can go.
final: prev: {
  kata-runtime = prev.kata-runtime.overrideAttrs (old: {
    postInstall = (old.postInstall or "") + ''
      substituteInPlace "$out/share/defaults/kata-containers/configuration-clh.toml" \
        --replace-fail \
          "$out/bin/cloud-hypervisor" \
          "${final.cloud-hypervisor}/bin/cloud-hypervisor"
    '';
  });
}
