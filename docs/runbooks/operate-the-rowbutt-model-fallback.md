---
title: Operate the Rowbutt model fallback
description: Check which model answers Rowbutt, keep turns off ChatGPT for a while or until a change, and drill the fallback.
---

[Rowbutt](../apps/mate.md) sends each model request to ChatGPT first, and to `MATE_FALLBACK_MODEL` when ChatGPT cannot answer. [Model routing](../apps/mate/how-it-works.md#model-routing) says when. Use this runbook when `MateModelPrimaryFailing` fires, to keep turns off ChatGPT, or to show that the fallback can continue a thread.

## Before you start

- Be the user in `MATE_ALLOWED_USER_IDS` on Discord, or in `MATE_SLACK_ALLOWED_USER_IDS` on Slack.
- Mention Rowbutt with each command.
- For the log check, get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).

## Check the route

1. Mention Rowbutt with `chatgpt status`.

   Result: mate says `Now: primary.`, or `Now: fallback since` with the reason and the time of the next try.

2. Read the failures of the mate log.

   ```bash
   kubectl --context offsite -n mate logs deploy/mate | grep 'ChatGPT failed' | tail -5
   ```

   Result: each line names the `reason` and the HTTP `status`.

## Pause and resume

A pause sends every turn to the fallback without a deploy. mate keeps the pause in memory, so a restart ends it. CD restarts mate at each new mate image, often several times a day.

1. Say `chatgpt pause` for 60 minutes, or `chatgpt pause <minutes>` for up to 10080.
2. To end the pause, say `chatgpt resume`.

## Switch to the fallback until a change

A switch in the Deployment stays through restarts.

1. In `clusters/offsite/apps/mate/deployment.yaml`, set `MATE_MODEL` to the value of `MATE_FALLBACK_MODEL`.
2. Set `MATE_FALLBACK_MODEL` to `none`.
3. Merge the change in a pull request.

   Result: after Flux rolls mate, its `mate starting` log line shows `"chatgpt":false`. mate neither refreshes the ChatGPT token nor answers `chatgpt` commands, and the model answers a `chatgpt` command as a prompt.

4. To switch back, revert the change in a pull request.

   Result: mate answers `chatgpt status` again. If it says mate is not signed in, do [Sign Rowbutt in to ChatGPT](sign-rowbutt-in-to-chatgpt.md).

## Drill the fallback

A drill shows that the fallback model can continue a thread that ChatGPT started.

1. In a thread that ChatGPT answered, say `chatgpt pause 5`.
2. Ask Rowbutt for a task that runs a command.

   Result: the status line starts with `↪️`, and the fallback model finishes the turn.

3. Say `chatgpt resume`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `MateModelPrimaryFailing` fires. | `chatgpt.com` is out of reach or fails, or refuses the request, such as for a model the plan lacks. | Do [Check the route](#check-the-route). Make sure that `chatgpt.com` is in `clusters/offsite/apps/mate/network-policy.yaml` on port 443. Check the plan. |
| A turn ends with `↪️ ChatGPT's usage limit is reached`. | The plan's usage limit is spent. | Wait for the reset. To stop the tries, say `chatgpt pause`. |
| A pause ends before its time. | mate restarted. | Say `chatgpt pause` again, or do [Switch to the fallback until a change](#switch-to-the-fallback-until-a-change). |
| A turn ends with `🔑`. | mate holds no working ChatGPT sign-in. | Do [Sign Rowbutt in to ChatGPT](sign-rowbutt-in-to-chatgpt.md). |

## Related

- [Rowbutt](../apps/mate.md)
- [How Rowbutt works](../apps/mate/how-it-works.md#model-routing)
- [Sign Rowbutt in to ChatGPT](sign-rowbutt-in-to-chatgpt.md)
