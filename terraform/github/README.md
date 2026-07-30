# GitHub repository

This root owns the `jonpulsifer/infra` repository through the GitHub provider.
The first adoption surface is repository metadata and merge settings. Existing
resources must be imported into the `terraform/github` state before Atlantis is
allowed to apply changes:

```text
tofu -chdir=terraform/github import github_repository.infra jonpulsifer/infra
```

The provider token is supplied to Atlantis as `GITHUB_TOKEN` (or `GH_TOKEN`);
it is deliberately not stored in this repository or in a SOPS file. GitHub
does not expose existing Actions secret values, so those resources are added
only when their plaintext is intentionally supplied in
`secrets.sops.yaml`. The file is encrypted with the repository's operator age
key before it is committed.

Branch protection, rulesets, labels, Actions variables/secrets, environments,
deploy keys, and webhooks are the next adoption surfaces. They should be
imported from the live API before declaration so the first plan is non-
destructive.
