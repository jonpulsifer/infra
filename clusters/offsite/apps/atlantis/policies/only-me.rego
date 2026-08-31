package hooks

import rego.v1

# `jonpulsifer[bot]` is the GitHub App the continuous-delivery digest bump now
# opens its pull requests as (`containers.yml`, app id 334190). It replaced
# `github-actions[bot]` there because a pull request opened with GITHUB_TOKEN
# never gets its checks run, so the digest could not merge — see
# [[Architecture/GitOps]]. The App is a new identity to this policy, and every
# CD pull request fails the plan hook until it is named here.
atlantis_users := {
    "jonpulsifer",
    "jonpulsifer[bot]",
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
