final: prev: {
  certmgr = (prev.certmgr.overrideAttrs (old: {
    patches = [
      ./patches/uri-san.patch
    ];
  }));
}
