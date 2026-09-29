---
title: Sign Rowbutt in to ChatGPT
description: Sign mate in to the owner's ChatGPT subscription from chat, check the sign-in, and sign it out.
---

This runbook signs [Rowbutt](../apps/mate.md) in to the owner's ChatGPT subscription with OpenAI's device code. mate, the process behind Rowbutt, keeps the token in the `mate_credentials` table of mate-db, the [session store](../apps/mate/how-it-works.md#session-store). At boot and every six hours, it refreshes a token with fewer than two days left. Turns use ChatGPT first, and `MATE_FALLBACK_MODEL` when ChatGPT cannot answer. Use this runbook to sign in, when `MateChatGPTSignedOut` or `MateChatGPTTokenNotRefreshing` fires, or to cut mate off. [Operate the Rowbutt model fallback](operate-the-rowbutt-model-fallback.md) pauses ChatGPT and handles `MateModelPrimaryFailing`.

> [!WARNING]
> This runbook changes live state by hand. It is an exception to the GitOps rule because OpenAI issues the token to mate, and git cannot hold it. The sandbox is `cluster-admin`, so the agent can read the token in mate-db and use the owner's ChatGPT account. The owner accepts this. The kill switch is [Sign out](#sign-out).

## Before you start

- Be the user in `MATE_ALLOWED_USER_IDS` on Discord, or in `MATE_SLACK_ALLOWED_USER_IDS` on Slack.
- Mention Rowbutt with each command. After a restart, mate ignores a reply without the mention in a thread that holds only commands.
- On Discord, allow direct messages from members of the `homelab` server.
- Sign in to your own ChatGPT account in a browser.
- For the log check, get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).

## Sign in

1. In an allowed channel or a Rowbutt thread, mention Rowbutt with `chatgpt login`.

   Result: mate says in the thread that it sent you a code, which works for 15 minutes.

2. Open the code: a direct message on Discord, or a message only you see at the bottom of the Slack channel.

> [!WARNING]
> The first person to enter the code connects their ChatGPT account to mate. Do not put the code in a thread.

3. Open the link in the message while you are signed in to your own ChatGPT account.
4. Enter the code.

   Result: mate says `✅ mate is signed in to ChatGPT`, with the time of one test request.

5. If mate says that the test request failed, find its reason in [If something goes wrong](#if-something-goes-wrong).

## Check the sign-in

1. Mention Rowbutt with `chatgpt status`.

   Result: mate says `ℹ️ ChatGPT: signed in, token good until`, with a date, and `Now: primary.`

2. Read the ChatGPT lines of the mate log.

   ```bash
   kubectl --context offsite -n mate logs deploy/mate | grep -i chatgpt | tail -5
   ```

   Result: The log shows `the ChatGPT token is refreshed` about every eight days, and no `refused` line.

## Sign out

1. Mention Rowbutt with `chatgpt logout`.

   Result: mate says `🔓 mate signed out of ChatGPT`, and deletes the token from mate-db.

> [!CAUTION]
> Step 2 also signs out every other app and device on the account, and any mate sign-in made before it.

2. In ChatGPT's security settings, sign out of all sessions.

   Result: OpenAI ends the account's sessions. No test has shown that this also ends an access token mate already holds, which works for up to 10 days.

## If something goes wrong

> [!CAUTION]
> Do not run a second mate against mate-db, such as a local run with its `DATABASE_URL`. Two holders of one refresh token can spend it twice, and OpenAI then refuses both.

| Symptom | Cause | Action |
| --- | --- | --- |
| `Couldn't send you the code by DM` | Discord refuses direct messages from the server. | Allow them, then say `chatgpt login` again. |
| `OpenAI refused to start a device sign-in (HTTP 404)` | Device code sign-in is off for the ChatGPT account. | Turn it on in ChatGPT's security settings. |
| `The sign-in code expired unused` | Nobody entered the code in 15 minutes. | Say `chatgpt login` again. |
| `mate restarted before the sign-in finished` | mate stopped while it waited for the code. | Say `chatgpt login` again. |
| `mate can't reach its memory right now` after `chatgpt login` | mate-db is down. | Do [Operate Postgres](operate-postgres.md). |
| `auth.openai.com could not be reached` or `chatgpt.com could not be reached` | mate's egress policy or DNS blocks the host. | Make sure that both hosts are in `clusters/offsite/apps/mate/network-policy.yaml` on port 443. |
| The test request failed with `HTTP 401` or `HTTP 403`. | The plan does not include Codex, or OpenAI refuses the client. | Check the plan in ChatGPT's settings. |
| `MateChatGPTSignedOut` fires, or `chatgpt status` says `OpenAI refused the token refresh`. | The refresh token is revoked or spent. | Do [Sign in](#sign-in). |
| `chatgpt status` says `chatgpt.com refused a fresh token too`. | chatgpt.com refuses the account or mate's client, not only the token. | Do [Sign in](#sign-in). If its test request fails with `HTTP 401` or `HTTP 403`, check the plan. |
| `MateChatGPTTokenNotRefreshing` fires. | A day of refreshes failed on egress, DNS or mate-db. | Read the mate log. If `MateStoreFailing` fires, do [Operate Postgres](operate-postgres.md). |
| After a restore of mate-db, `chatgpt status` says `not signed in`. | The nightly dump leaves out `mate_credentials`. | Do [Sign in](#sign-in). |

## Related

- [Rowbutt](../apps/mate.md)
- [How Rowbutt works](../apps/mate/how-it-works.md)
- [Operate the Rowbutt model fallback](operate-the-rowbutt-model-fallback.md)
- [Operate Postgres](operate-postgres.md)
