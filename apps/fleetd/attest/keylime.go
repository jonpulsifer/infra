package attest

// KeylimeRefstate renders a profile as the reference state Keylime's
// fleetd-profile policy (apps/keylime-policy/lolwtf_mb_policy.py) reads: the
// profile's own keys, with required_authorities already the list that
// governs the boot in question, since Keylime judges only running nodes and
// knows no intake. Every list is present, so a consumer reads [] and never
// null.
func KeylimeRefstate(p *Policy, renewal bool) map[string]any {
	required := p.RequiredAuthorities
	if renewal {
		required = p.RenewRequiredAuthorities
	}
	list := func(s []string) []string {
		if s == nil {
			return []string{}
		}
		return s
	}
	names := p.Names
	if names == nil {
		names = map[string]string{}
	}
	pcrs := p.PCRs
	if pcrs == nil {
		pcrs = []int{}
	}
	return map[string]any{
		"pcrs":                      pcrs,
		"secure_boot":               p.SecureBoot,
		"platform_keys":             list(p.PlatformKeys),
		"key_exchange_keys":         list(p.KeyExchangeKeys),
		"db":                        map[string]any{"required": list(p.DB.Required), "allowed": list(p.DB.Allowed)},
		"pre_separator_authorities": list(p.PreSeparatorAuthorities),
		"authorities":               list(p.Authorities),
		"required_authorities":      list(required),
		"boot_applications":         list(p.BootApplications),
		"names":                     names,
	}
}
