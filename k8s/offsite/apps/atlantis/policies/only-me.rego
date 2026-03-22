package hooks

import rego.v1

atlantis_users := {
    "jonpulsifer",
    "renovate[bot]",
}

allowed if {
    some atlantis_user in atlantis_users
    input.user == atlantis_user
}

deny contains msg if {
    not allowed
    msg = sprintf("%s is not in the allowed users list. Want one of %s", [input.user, atlantis_users])
}
