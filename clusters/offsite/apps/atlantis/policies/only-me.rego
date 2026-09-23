package hooks

import rego.v1

# `jonpulsifer[bot]` is the GitHub App the continuous-delivery digest bump now
# opens its pull requests as (`containers.yml`, app id 334190). It replaced
# `github-actions[bot]` there because a pull request opened with GITHUB_TOKEN
# never gets its checks run, so the digest could not merge — see
# [[Architecture/GitOps]]. The App is a new identity to this policy, and every
# CD pull request fails the plan hook until it is named here.
#
# `clanky-bot[bot]` is the App a mate sandbox pushes and opens pull requests
# as. Naming it here lets its Terraform pull requests plan, which is the whole
# of what it buys: this set gates `plan-hook.sh`, and that hook runs on `plan`
# alone. Applying needs the `policy_check` step to pass as well, and
# `default-deny.rego` denies every plan there is — so an apply also needs
# `atlantis approve_policies` from somebody under `policies.owners.users` in
# the HelmRelease, where this identity deliberately does not appear. An agent
# can therefore propose infrastructure and never enact it.
atlantis_users := {
    "jonpulsifer",
    "jonpulsifer[bot]",
    "clanky-bot[bot]",
    "rowbutt",
    "renovate[bot]",
    "dependabot[bot]",
    "github-actions[bot]",
}

allowed if {
    some atlantis_user in atlantis_users
    input.user == atlantis_user
}

deny contains msg if {
    not allowed
    msg = sprintf("%s is not in the allowed users list. Want one of %s", [input.user, atlantis_users])
}
