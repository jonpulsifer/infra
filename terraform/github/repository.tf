locals {
  repository = "infra"
}

resource "github_repository" "infra" {
  name        = local.repository
  description = "home ops are the best ops"
  visibility  = "public"

  has_issues   = true
  has_projects = true
  has_wiki     = false

  delete_branch_on_merge = true
  allow_squash_merge     = true
  allow_merge_commit     = true
  allow_rebase_merge     = true
}

output "repository" {
  description = "Managed repository full name."
  value       = github_repository.infra.full_name
}
