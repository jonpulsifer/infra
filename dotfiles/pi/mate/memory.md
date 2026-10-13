# Memory

What Rowbutt has learned, one fact a line in the present tense, with the date it was learned and the file it belongs to when there is one. The nightly dream adds, corrects and prunes these lines, and the owner reviews each change as a pull request. Every profile and the owner's local pi read this file into the system prompt, so it holds facts about the lab and how the owner works, never a capability, a credential or a private detail. Keep it under 120 lines.

## The lab

- 2026-10-13: CD rebuilds the mate image at every merge that touches it, so a restart mid-turn is routine and the next message resumes the turn (`docs/apps/mate/how-it-works.md`).
- 2026-10-13: Alertmanager counts a 4xx from a webhook as a failed notification, and `AlertmanagerClusterFailedToSendAlerts` is critical, so a receiver answers 5xx to anything it will handle later (`docs/platform/observability/alerting.md`).

## How the owner works

- 2026-10-13: A report reads exception-first: what needs the owner, then what was fixed, then what could not be checked; a healthy day is one line.
- 2026-10-13: Pull request and commit text is self-contained: no tracker ids, no `.agent/` paths and no attribution lines.

## Mistakes not to repeat

- 2026-10-13: A docs change runs `mise run docs:check` before it is pushed; a past-tense word or a path that does not exist fails CI.
