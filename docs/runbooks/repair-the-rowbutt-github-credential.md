---
title: Repair the Rowbutt GitHub credential
description: Check, resync, rotate and replace the GitHub App credential that Rowbutt's sandboxes push with.
---

This runbook repairs the GitHub credential of [Rowbutt](../apps/mate.md). mate, the process that runs Rowbutt, makes a GitHub token for each turn (one prompt and the agent's answer) from the private key of the `clanky-bot` GitHub App. Use it when `MateGitHubCredentialBroken` or `MateGitHubTokenMintFailing` fires, or when a sandbox cannot push.

> [!WARNING]
> This runbook changes the GitHub App, the 1Password item and an ExternalSecret annotation by hand. It is an exception to the GitOps rule because git does not hold the private key or the App settings. Do not edit the `mate-github-app` Secret. External Secrets overwrites it within the hour.

## Before you start

- Get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).
- Get write access to the `homelab` vault in 1Password.
- Get admin access to the GitHub App.
- Install `gh`.

## Check the credential

mate tests the key at start and every 15 minutes.

1. Read the last GitHub lines of the mate log.

   ```bash
   kubectl --context offsite -n mate logs deploy/mate | grep -i -E 'github|credentials' | tail -5
   ```

   Result: The log shows `github app ready`, with the login `clanky-bot[bot]` and a future `expiresAt`.

2. Read the ExternalSecret status.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-github-app
   ```

   Result: The command prints `SecretSynced` and `True`.

## Resync the Secret

Do this procedure to apply a 1Password change now. Reloader, a controller that restarts pods when their Secret changes, restarts mate after the sync.

1. Annotate the ExternalSecret.

   ```bash
   kubectl --context offsite -n mate annotate externalsecret mate-github-app \
     force-sync="$(date +%s)" --overwrite
   ```

2. Read the ExternalSecret.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-github-app
   ```

   Result: `LAST SYNC` shows a few seconds, and `STATUS` is `SecretSynced`.

3. If the Secret changed, wait until Reloader restarts mate.

   ```bash
   kubectl --context offsite -n mate rollout status deploy/mate
   ```

   Result: The command prints `deployment "mate" successfully rolled out`.

4. Do step 1 of [Check the credential](#check-the-credential).

## Rotate the private key

1. In GitHub, open Settings > Developer settings > GitHub Apps > `clanky-bot`.
2. Select Generate a private key.

   Result: The browser downloads a `.pem` file. The old key stays valid.

> [!WARNING]
> Do not put the key or its base64 in git or in a chat.

3. Encode the key as one line of base64.

   ```bash
   base64 -w0 <key>.pem > <key>.b64
   ```

> [!CAUTION]
> If the field `pem (base64)` holds PEM text or wrapped base64, mate cannot parse the key.

4. Put the content of `<key>.b64` in the field `pem (base64)` of the item `clanky-bot github app` in the `homelab` vault.
5. Do [Resync the Secret](#resync-the-secret).

> [!CAUTION]
> If you delete the old key before step 5 passes, mate cannot make tokens.

6. In the App settings, delete the old private key.
7. Delete `<key>.pem` and `<key>.b64`.

## Replace the App

If the `clanky-bot` App is deleted or unusable, do this procedure. `<slug>` is the name of the new App in its URL.

1. In Settings > Developer settings > GitHub Apps, create an App with no webhook.
2. Give it these repository permissions: Contents read and write, Pull requests read and write, Actions read-only.
3. Record the App ID.
4. Install the App on the `jonpulsifer` account, for the `infra` repository only.
5. Get the user ID of the App's bot.

   ```bash
   gh api 'users/<slug>[bot]' --jq .id
   ```

   Result: The command prints `<bot-id>`.

6. Open a pull request that sets these values:

   - `MATE_GITHUB_APP_ID` in `clusters/offsite/apps/mate/deployment.yaml`: the App ID
   - `GIT_USER` in `apps/mate/src/sandboxes.ts`: `<slug>[bot]`
   - `GIT_EMAIL` in the same file: `<bot-id>+<slug>[bot]@users.noreply.github.com`
   - `clanky-bot[bot]` in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego`: `<slug>[bot]`

> [!CAUTION]
> mate cannot make tokens from step 7 until it restarts with the new App ID.

7. In the new App settings, do steps 2 to 4 of [Rotate the private key](#rotate-the-private-key).
8. Merge the pull request.
9. Wait until the CD pull request for the `mate` image digest merges.
10. Do [Resync the Secret](#resync-the-secret).

    Result: The log shows `github app ready`, with the login `<slug>[bot]`.

11. Delete the old App.
12. Delete `<key>.pem` and `<key>.b64`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The log shows `private key does not parse`. | `pem (base64)` holds PEM text or wrapped base64. | Do [Rotate the private key](#rotate-the-private-key). |
| The log shows `could not be opened`. | The Secret does not exist. | Read the ExternalSecret events with `kubectl describe`. |
| The status is `SecretSyncedError`. | `pem (base64)` is missing. 1Password Connect returns no value for the `password` field of a Password item. | Put the key in `pem (base64)`. |
| The log shows `github said 401`. | GitHub refuses the key or the App ID. | Rotate the key. Make sure that `MATE_GITHUB_APP_ID` is correct. |
| The log shows `find installation: github said 404`. | The App is not installed on `infra`. | In the App settings, install it on `jonpulsifer/infra` only. mate finds it within 15 minutes. |
| `gh` prints `no token in`, or git prints `could not read Username`. | The turn has no token. | Read the `could not mint` and `could not stamp` lines in the mate log. |
| The log shows `could not mint`. | mate could not make the token. | Do [Check the credential](#check-the-credential). |
| The log shows `could not stamp`. | `pods/exec` into the sandbox failed. | Read the `error` field of the line. |
| The push does not end. | The sandbox egress policy blocks the host. | Read `clusters/offsite/apps/mate/sandbox-network-policy.yaml`. |

## Related

- [Rowbutt](../apps/mate.md)
- [How Rowbutt works](../apps/mate/how-it-works.md)
- [Secrets](../platform/secrets.md)
