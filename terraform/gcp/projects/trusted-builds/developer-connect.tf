resource "google_project_service_identity" "developer_connect" {
  provider = google-beta

  project = data.google_project.current.project_id
  service = "developerconnect.googleapis.com"

  depends_on = [google_project_service.service]
}

# Developer Connect writes the OAuth token to a Secret Manager secret it creates here.
resource "google_project_iam_member" "developer_connect_secret_admin" {
  project = local.project
  role    = "roles/secretmanager.admin"
  member  = google_project_service_identity.developer_connect.member
}

# Stays in PENDING_USER_OAUTH until a human follows installation_state.action_uri; see
# docs/runbooks/authorize-developer-connect.md. The server fills app_installation_id and
# authorizer_credential; leave them undeclared.
resource "google_developer_connect_connection" "github" {
  location      = local.region
  connection_id = "github"

  github_config {
    github_app = "DEVELOPER_CONNECT"
  }

  # The service agent creates the token secret on create; without the grant
  # first, the API returns SECRET_CREATE_PERMISSION_MISSING.
  depends_on = [google_project_iam_member.developer_connect_secret_admin]
}

resource "google_developer_connect_git_repository_link" "infra" {
  location               = local.region
  parent_connection      = google_developer_connect_connection.github.connection_id
  git_repository_link_id = "jonpulsifer-infra"
  clone_uri              = "https://github.com/jonpulsifer/infra.git"
}
