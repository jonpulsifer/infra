---
title: Authorize Developer Connect
description: Authorize the Developer Connect GitHub connection in the trusted-builds project after Atlantis creates or replaces it.
---

Developer Connect is the Google Cloud service that links GitHub repositories to Cloud Build. `terraform/gcp/projects/trusted-builds/developer-connect.tf` creates the connection `github`, with no credentials, and the repository link `jonpulsifer-infra` for `jonpulsifer/infra`. No Cloud Build trigger uses the link, so an unauthorized connection breaks no build. The connection stays in the `PENDING_USER_OAUTH` stage until a person authorizes it in a browser. Use this runbook after Atlantis creates or replaces the connection.

Developer Connect keeps the OAuth token in a Secret Manager secret that it creates in `trusted-builds`. The token is not in git or in the OpenTofu state.

## Before you start

- You need `gcloud` access to the `trusted-builds` project.
- You need the GitHub login of the owner of `jonpulsifer/infra`.

## Authorize the connection

1. Read the stage of the connection.

   ```bash
   gcloud developer-connect connections describe github \
     --project=trusted-builds --location=northamerica-northeast1 \
     --format='value(installationState.stage)'
   ```

   Result: `PENDING_USER_OAUTH`. If the result is `COMPLETE`, stop. The connection needs no authorization.

2. Get the authorization URL.

   ```bash
   gcloud developer-connect connections describe github \
     --project=trusted-builds --location=northamerica-northeast1 \
     --format='value(installationState.actionUri)'
   ```

   Result: A URL.

> [!CAUTION]
> The connection binds to the GitHub account that is signed in to the browser. To change the account after the authorization, you must replace the connection.

3. In the browser, sign in to GitHub as the owner of `jonpulsifer/infra`.
4. Open the URL from step 2.
5. Authorize the Developer Connect GitHub App.
6. When GitHub asks where to install the App, select only the `jonpulsifer/infra` repository.
7. Do step 1 again.

   Result: `COMPLETE`.

## Replace the connection

If the connection is bound to the wrong GitHub account, do this procedure. A replacement breaks no build.

1. Read the GitHub account of the connection.

   ```bash
   gcloud developer-connect connections describe github \
     --project=trusted-builds --location=northamerica-northeast1 \
     --format='value(githubConfig.authorizerCredential.username)'
   ```

   Result: The GitHub user name. If the user name is the owner of `jonpulsifer/infra`, stop.

> [!CAUTION]
> Atlantis merges the pull request after the apply. Put no other change in it.

2. On a new branch from `main`, make an empty commit.

   ```bash
   git commit --allow-empty -m 'fix(trusted-builds): replace the Developer Connect connection'
   ```

3. Push the branch.
4. Open a pull request.
5. On the pull request, comment the plan command with a replacement.

   ```text
   atlantis plan -d terraform/gcp/projects/trusted-builds -- -replace=google_developer_connect_connection.github -target=google_developer_connect_connection.github
   ```

   Result: A `Ran Plan for` comment with `Plan: 1 to add, 0 to change, 1 to destroy.`

6. Read the plan. If it changes a resource other than `google_developer_connect_connection.github`, do not apply it.
7. Apply the plan.

   ```text
   atlantis apply -d terraform/gcp/projects/trusted-builds
   ```

   Result: A `Ran Apply for` comment that names `terraform/gcp/projects/trusted-builds`.

8. Do [Authorize the connection](#authorize-the-connection).
9. List the repository links of the connection.

   ```bash
   gcloud developer-connect connections git-repository-links list \
     --connection=github --project=trusted-builds \
     --location=northamerica-northeast1 --format='value(name)'
   ```

   Result: A name that ends in `gitRepositoryLinks/jonpulsifer-infra`, or no output.

10. If step 9 prints no output, open a new pull request, as in steps 2 to 4.
11. On that pull request, comment the plan command.

    ```text
    atlantis plan -d terraform/gcp/projects/trusted-builds
    ```

    Result: A plan that creates `google_developer_connect_git_repository_link.infra`.

12. Apply the plan.

    ```text
    atlantis apply -d terraform/gcp/projects/trusted-builds
    ```

    Result: `Automatically merging because all plans have been successfully applied.`

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| A plan changes `google_developer_connect_connection.github`. | Developer Connect sets `app_installation_id` and `authorizer_credential`, so a declared value for either field makes a diff. Other causes are a provider version or a change to the connection outside OpenTofu. | Do not apply the plan. If `developer-connect.tf` declares either field, remove it. Otherwise, find out why the connection changed. |
| Step 7 fails to destroy the connection, and the error names the repository link. | The repository link blocks the delete. | Comment `atlantis plan -d terraform/gcp/projects/trusted-builds -- -destroy -target=google_developer_connect_git_repository_link.infra`. Comment `atlantis apply`. Do this procedure again from step 2. |
| The apply fails with `SECRET_CREATE_PERMISSION_MISSING`. | The Developer Connect service agent, a Google-managed service account, did not have `roles/secretmanager.admin` when OpenTofu created the connection. | Make sure that the `depends_on` of the connection names `google_project_iam_member.developer_connect_secret_admin`. Comment the plan command again. Comment `atlantis apply`. |

## Related

- [Apply an OpenTofu change](apply-an-opentofu-change.md): the Atlantis plan and apply.
- [Cloud accounts](../platform/cloud.md): the Google Cloud projects.
