package hooks

import rego.v1

atlantis_users := {
    "jonpulsifer",
}

allowed if {
    some atlantis_user in atlantis_users
    input.user == atlantis_user
}

deny contains msg if {
    not allowed
    msg = sprintf("User is not in the allowed users list. Want one of %s", [atlantis_users])
}
