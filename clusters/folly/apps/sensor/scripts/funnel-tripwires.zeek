##! Tripwires for tsidp's Funnel (docs/platform/identity.md#when-to-switch-to-the-passthrough).
##! The uplink carries Funnel's HTTP only inside WireGuard, so these watch what
##! the mirror can see: a folly host opening TLS to tsidp's Funnel name, and the
##! number of UDP flows between spore and the internet. FUNNEL_FETCHERS names the hosts
##! expected to fetch tsidp's keys through Funnel, and SPORE_IP the host tsidp
##! runs on; the Deployment sets both from the topology ConfigMaps.

@load base/frameworks/notice
@load base/frameworks/sumstats
@load base/protocols/ssl

module FunnelTripwire;

export {
	redef enum Notice::Type += {
		## A folly host other than FUNNEL_FETCHERS opened TLS to tsidp's name,
		## which only Funnel serves over the internet.
		Funnel_TLS,
		## More UDP flows between spore and non-local addresses in one window
		## than flow_threshold, not counting ignored_ports.
		Spore_Internet_UDP,
	};

	## Flows per window at which Spore_Internet_UDP fires. Measured 2026-11-04
	## 01:10-02:10Z, spore's first hour running tsidp, without ignored_ports: 11, 8,
	## 3, 2, 2 and 1 flows per 10 minutes, and 14 at most in the 24 hours before,
	## the window where tailscaled and tsidp started. Funnel's ingress relays keep
	## long-lived flows that the API servers' and tsidp-check's fetches reuse.
	const flow_threshold = 30.0 &redef;
	const window = 10 min &redef;

	## spore's own internet UDP that is not WireGuard: its resolver's upstream
	## DNS, its NTP, and the STUN probes that tailscaled and tsidp's node send to
	## every DERP region.
	const ignored_ports: set[port] = { 53/udp, 123/udp, 3478/udp } &redef;

	## tsidp's Funnel name: providers.tailscale.hostname in
	## clusters/base/config/kube-login.json, under any tailnet. Neither that file
	## nor the tailnet in terraform/network/tailscale/fleet.tf.json reaches this
	## kustomization or Flux's substitution, so the hostname is matched here.
	const tsidp_name = /^idp\.[a-z0-9-]+\.ts\.net\.?$/ &redef;
}

global fetchers: set[addr];
global spore: addr = 0.0.0.0;

event zeek_init()
	{
	for ( _, a in split_string(getenv("FUNNEL_FETCHERS"), /,/) )
		if ( is_valid_ip(a) )
			add fetchers[to_addr(a)];
	if ( is_valid_ip(getenv("SPORE_IP")) )
		spore = to_addr(getenv("SPORE_IP"));

	local r = SumStats::Reducer($stream="funnel.spore_udp", $apply=set(SumStats::SUM));
	SumStats::create([$name="funnel-spore-udp", $epoch=window, $reducers=set(r),
	    $threshold=flow_threshold,
	    $threshold_val(key: SumStats::Key, result: SumStats::Result) = {
		return result["funnel.spore_udp"]$sum;
	    },
	    $threshold_crossed(key: SumStats::Key, result: SumStats::Result) = {
		NOTICE([$note=Spore_Internet_UDP,
		    $msg=fmt("at least %.0f UDP flows between spore and the internet in %s", result["funnel.spore_udp"]$sum, window),
		    $identifier="spore"]);
	    }]);
	}

event ssl_extension_server_name(c: connection, is_client: bool, names: string_vec)
	{
	if ( ! is_client || ! Site::is_local_addr(c$id$orig_h) || c$id$orig_h in fetchers )
		return;
	for ( _, name in names )
		if ( tsidp_name in to_lower(name) )
			NOTICE([$note=Funnel_TLS, $conn=c, $sub=name,
			    $msg=fmt("%s opened TLS to the Funnel name %s", c$id$orig_h, name),
			    $identifier=cat(c$id$orig_h, name)]);
	}

event connection_state_remove(c: connection)
	{
	if ( spore == 0.0.0.0 || get_port_transport_proto(c$id$resp_p) != udp )
		return;
	if ( c$id$resp_p in ignored_ports || c$id$orig_p in ignored_ports )
		return;
	local remote = c$id$orig_h == spore ? c$id$resp_h : c$id$orig_h;
	if ( (c$id$orig_h == spore || c$id$resp_h == spore) && ! Site::is_local_addr(remote) )
		SumStats::observe("funnel.spore_udp", [], [$num=1]);
	}
