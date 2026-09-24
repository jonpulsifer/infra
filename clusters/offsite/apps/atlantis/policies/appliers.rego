package appliers

import rego.v1

# Who may comment `atlantis apply` or `atlantis import`. Plan runs the pull
# request's code with Atlantis's credentials, so only-me.rego is a trust list too.
atlantis_appliers := {"jonpulsifer"}

allowed if input.user in atlantis_appliers

deny contains msg if {
    not allowed
    msg := sprintf("%v may not apply. Only %v can.", [object.get(input, "user", "<missing>"), atlantis_appliers])
}
