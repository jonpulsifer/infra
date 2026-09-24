package hooks

import rego.v1

# Who may run `atlantis plan`. jonpulsifer[bot] opens the continuous-delivery
# pull requests, and clanky-bot[bot] is the identity a Rowbutt sandbox pushes
# as. appliers.rego limits `atlantis apply` separately.
atlantis_users := {
    "jonpulsifer",
    "jonpulsifer[bot]",
    "clanky-bot[bot]",
    "rowbutt",
    "renovate[bot]",
    "dependabot[bot]",
    "github-actions[bot]",
}

allowed if input.user in atlantis_users

deny contains msg if {
    not allowed
    msg := sprintf("%v is not in the allowed users list. Want one of %v", [object.get(input, "user", "<missing>"), atlantis_users])
}
