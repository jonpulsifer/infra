# The managed GitHub App flow: the connection is created credential-less and
# sits in PENDING_USER_OAUTH until a human follows installation_state.action_uri
# once — see [[Runbooks/Developer Connect GitHub OAuth]]. Developer Connect then
# writes the OAuth token into a Secret Manager secret it creates in this
# project, which is why its service agent holds secretmanager.admin.
# app_installation_id and authorizer_credential are server-populated after the
# OAuth completes; both are optional+computed, so leaving them undeclared
# produces no diff.
resource "google_project_service_identity" "developer_connect" {
  provider = google-beta

  project = data.google_project.current.project_id
  service = "developerconnect.googleapis.com"

  depends_on = [google_project_service.service]
}

resource "google_project_iam_member" "developer_connect_secret_admin" {
  project = local.project
  role    = "roles/secretmanager.admin"
  member  = google_project_service_identity.developer_connect.member
}

resource "google_developer_connect_connection" "github" {
  location      = local.region
  connection_id = "github"

  github_config {
    github_app = "DEVELOPER_CONNECT"
  }

  # Creating the connection makes the service agent create the token secret,
  # so the secretmanager.admin grant must exist first — without this edge the
  # two race and the API returns SECRET_CREATE_PERMISSION_MISSING.
  depends_on = [google_project_iam_member.developer_connect_secret_admin]
}
