# dinghy: the cloud bosun fleet's value play, and its widest pool.
#
# c3-standard-22 -- Sapphire Rapids, 3.0 GHz sustained all-core. C3 Spot cores
# cost $0.00981 against C4's $0.02079, so this host buys 22 vCPU and 88 GB for
# less per hour than tender's 16 and 60. The open question it exists to answer:
# whether 30% slower cores, six-deep, beat faster cores four-deep on real CI.
#
# 88 GB of RAM: six warm skiffs on the shared label (18 GiB) plus the
# hosted-shaped bench slot (16 GiB) is 34 GiB declared.
{
  imports = [ ../profiles/bosun-cloud.nix ];

  bosunCloud = {
    warmUbuntu = 6;
    memoryMax = "72G";
  };
}
