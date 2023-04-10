final: prev: {
  open-policy-agent = prev.open-policy-agent.overrideAttrs (old: {
    doCheck = false;
    doInstallCheck = false;
  });
}
