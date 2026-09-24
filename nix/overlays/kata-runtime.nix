# kata installs configuration-clh.toml with CLHPATH at $out/bin/cloud-hypervisor, which nixpkgs never
# provides. Point it at the real cloud-hypervisor.
final: prev: {
  kata-runtime = prev.kata-runtime.overrideAttrs (old: {
    # Patch after install: the build reads makeFlags through a rec self-reference, so a CLHPATH override
    # never reaches make. --replace-fail breaks the build once nixpkgs wires CLHPATH; then drop this overlay.
    postInstall = (old.postInstall or "") + ''
      substituteInPlace "$out/share/defaults/kata-containers/configuration-clh.toml" \
        --replace-fail \
          "$out/bin/cloud-hypervisor" \
          "${final.cloud-hypervisor}/bin/cloud-hypervisor"
    '';
  });
}
