final: prev: {
  httpie = prev.httpie.overrideAttrs (old: {
    doCheck = false;
    doInstallCheck = false;
  });
}
