# tender: the cloud bosun fleet's speed baseline. A tender is the boat that
# services the ship.
#
# c4-standard-16 -- Granite Rapids, 3.9 GHz sustained all-core, the fastest
# silicon GCE will nest a VM inside. Every number in apps/bosun/README.md was
# measured on this family, so this is the host the other two are read against.
#
# 60 GB of RAM: four warm skiffs on the shared label (12 GiB) plus the
# hosted-shaped bench slot (16 GiB) is 28 GiB declared. vCPU oversubscribes on
# purpose -- 5 x 4 vCPU against 16 physical -- because a warm skiff is idle
# until GitHub hands it a job, and RAM, not cores, is what a booted skiff
# actually holds.
{
  imports = [ ../profiles/bosun-cloud.nix ];

  bosunCloud = {
    warmUbuntu = 4;
    memoryMax = "48G";
  };
}
