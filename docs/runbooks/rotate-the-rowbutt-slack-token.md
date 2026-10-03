---
title: Rotate the Rowbutt Slack token
description: Replace the Slack App-Level Token that Rowbutt's Socket Mode connection uses, and revoke the tokens of clients that share its events.
---

This runbook replaces the App-Level Token of the Slack app behind [Rowbutt](../apps/mate.md). mate opens one Socket Mode connection with it, and Slack splits the app's events across every connection that holds a token. Use it when mate logs `slack is splitting events across connections`, or when the token leaks.

> [!WARNING]
> This runbook changes the Slack app, the 1Password item and an ExternalSecret annotation by hand. It is an exception to the GitOps rule because git does not hold the token or the app settings. Do not edit the `mate-slack` Secret. External Secrets overwrites it within the hour.

## Before you start

- Get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).
- Get write access to the `homelab` vault in 1Password.
- Get admin access to the Slack app.

## Check the connections

Slack refreshes each connection every few hours, and mate logs `slack socket ready` at each refresh.

1. Read the last socket lines of the mate log.

   ```bash
   kubectl --context offsite -n mate logs deploy/mate | grep -E 'slack socket ready|splitting' | tail -3
   ```

   Result: The last `slack socket ready` line has `"connections":1`, and no `splitting` line follows it.

2. If `connections` is more than 1, another client holds a token of the app. Do [Rotate the token](#rotate-the-token).

## Rotate the token

The `appId` field of the `slack socket ready` line names the app.

1. Open `https://api.slack.com/apps`, and select the app.
2. Open Basic Information, then App-Level Tokens.
3. Record the name and creation date of each token.
4. Open Collaborators. Make sure that you know each collaborator.
5. In App-Level Tokens, select "Generate Token and Scopes".
6. Give the token a name that includes the month.
7. Add the scope `connections:write`.
8. Select "Generate", then copy the `xapp-` token.

> [!WARNING]
> Do not put the token in git or in a chat.

9. In the `homelab` vault, open the item `slack: rowbutt`.
10. Put the new token in the field `App-Level Token`. Do not change the other fields.
11. Do [Apply the change](#apply-the-change).

> [!CAUTION]
> If you revoke the old token before step 11 passes, mate loses Slack at its next refresh.

12. In App-Level Tokens, revoke the old token.
13. Revoke each other token from your record in step 3 that you do not know.

## Apply the change

The ExternalSecret `mate-slack` in `clusters/offsite/apps/mate/external-secret.yaml` refreshes every hour. Reloader, a controller that restarts pods when their Secret changes, then restarts mate. The `Recreate` strategy stops the old connection before the new pod starts. To wait for the refresh, start at step 3.

1. Annotate the ExternalSecret.

   ```bash
   kubectl --context offsite -n mate annotate externalsecret mate-slack \
     force-sync="$(date +%s)" --overwrite
   ```

2. Read the ExternalSecret.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-slack
   ```

   Result: `LAST SYNC` shows a few seconds, and `STATUS` is `SecretSynced`.

3. Wait until Reloader restarts mate.

   ```bash
   kubectl --context offsite -n mate rollout status deploy/mate
   ```

   Result: The command prints `deployment "mate" successfully rolled out`.

4. Do [Check the connections](#check-the-connections).

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `connections` stays above 1 for some hours after the revoke. | Slack's documentation does not say if a revoke closes open connections. A client drops at its next refresh. | Do [Check the connections](#check-the-connections) again after 6 hours. |
| `connections` stays above 1 for a day after the revoke. | A client holds a token that you did not revoke. | Read the App-Level Tokens and Collaborators again, and revoke what you do not know. |
| `STATUS` is `SecretSyncedError`. | The item has no field named `App-Level Token`. | Correct the field name in the item. |
| The log shows no `slack socket ready` line after the restart. | Slack refuses the new token. | Make sure that the token has `connections:write`. Generate it again if it does not. |

## Related

- [Rowbutt](../apps/mate.md)
- [Repair the Rowbutt GitHub credential](repair-the-rowbutt-github-credential.md)
- [Secrets](../platform/secrets.md)
