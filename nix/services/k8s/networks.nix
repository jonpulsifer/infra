{
  folly = {
    apiServerIP = "10.3.0.10";
    apiServerHostname = "k8s.lolwtf.ca";
    apiServerPort = 6443;
    podCidr = "10.100.0.0/20";
    serviceCidr = "10.10.0.0/16";
    dns = [
      "10.10.0.254"
      "10.3.0.1"
    ];
    upstreamDns = "10.3.0.1";
  };

  offsite = {
    apiServerIP = "192.168.2.10";
    apiServerHostname = "offsite.lolwtf.ca";
    apiServerPort = 6443;
    podCidr = "10.101.0.0/20";
    serviceCidr = "10.11.0.0/16";
    dns = [
      "10.11.0.254"
      "192.168.2.1"
    ];
    upstreamDns = "192.168.2.1";
  };
}
