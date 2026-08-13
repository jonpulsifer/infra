# launch: the cloud bosun fleet's commodity floor. A launch is the ship's
# workboat -- the one that is always available.
#
# n2-standard-16 -- Cascade Lake or Ice Lake, whichever the zone hands out.
# N2 is the family every project already has quota for (200 vCPU here against
# C4's 50), so this host answers the question a reader of the benchmark will
# actually ask: what does a warm pool cost on ordinary silicon, without a
# quota request?
#
# 64 GB of RAM: four warm skiffs on the shared label (12 GiB) plus the
# hosted-shaped bench slot (16 GiB) is 28 GiB declared.
{
  imports = [ ../profiles/bosun-cloud.nix ];

  bosunCloud = {
    warmUbuntu = 4;
    memoryMax = "52G";
  };
}
