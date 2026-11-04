##! Tripwires for tsidp's Funnel (docs/platform/identity.md#when-to-switch-to-the-passthrough).
##! The uplink carries Funnel's HTTP only inside WireGuard, so these watch what
##! the mirror can see: a folly host opening TLS to a Funnel name, and the volume
##! of UDP between spore and the internet. FUNNEL_FETCHERS names the hosts
##! expected to fetch tsidp's keys through Funnel, and SPORE_IP the host tsidp
##! runs on; the Deployment sets both from the topology ConfigMaps.

@load base/frameworks/notice
@load base/frameworks/sumstats
@load base/protocols/ssl

module FunnelTripwire;

export {
	redef enum Notice::Type += {
		## A folly host other than FUNNEL_FETCHERS opened TLS to a *.ts.net name,
		## which only Funnel serves over the internet.
		Funnel_TLS,
		## More UDP flows between spore and non-local addresses in one window
		## than flow_threshold.
		Spore_Internet_UDP,
	};

	## Flows per window above which Spore_Internet_UDP fires. Spore's tailscaled
	## has almost no direct internet peers; Funnel's ingress relays add a few
	## long-lived flows, and the API servers' and tsidp-check's fetches reuse them.
	const flow_threshold = 30.0 &redef;
	const window = 10 min &redef;
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
		if ( /\.ts\.net\.?$/ in to_lower(name) )
			NOTICE([$note=Funnel_TLS, $conn=c, $sub=name,
			    $msg=fmt("%s opened TLS to the Funnel name %s", c$id$orig_h, name),
			    $identifier=cat(c$id$orig_h, name)]);
	}

event connection_state_remove(c: connection)
	{
	if ( spore == 0.0.0.0 || get_port_transport_proto(c$id$resp_p) != udp )
		return;
	local remote = c$id$orig_h == spore ? c$id$resp_h : c$id$orig_h;
	if ( (c$id$orig_h == spore || c$id$resp_h == spore) && ! Site::is_local_addr(remote) )
		SumStats::observe("funnel.spore_udp", [], [$num=1]);
	}
