package appliers

import rego.v1

# Who may comment `atlantis apply`. Planning identities live in only-me.rego;
# a bot on that list can propose infrastructure but never apply it.
atlantis_appliers := {"jonpulsifer"}

deny contains msg if {
    not input.user in atlantis_appliers
    msg = sprintf("%s may not apply. Only %s can.", [input.user, atlantis_appliers])
}
