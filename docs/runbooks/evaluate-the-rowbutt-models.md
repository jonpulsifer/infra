---
title: Evaluate the Rowbutt models
description: Read what Rowbutt's recorded turns say about each model, and replay its recorded tool decisions against a candidate model before changing MATE_MODEL or the fallback.
---

[Rowbutt](../apps/mate.md) keeps every thread's session in `mate-db`, and each recorded step names the model that answered it. `bun run evals` in `apps/mate` reads that store and prints two things: a ledger of what the recorded steps show about each model, and, with `--model`, a decision replay that puts the recorded context in front of a candidate model at each recorded tool call and scores whether it picked the same tool and the same action. Use it before changing `MATE_MODEL` or `MATE_FALLBACK_MODEL` in `clusters/offsite/apps/mate/deployment.yaml`, or when a model looks slow or wasteful in chat.

The replay measures agreement with the recorded model one step at a time, not correctness: once a candidate picks another path the recorded tool results fit it no more, so each decision asks for one call and runs nothing after it. Read the thread of a disagreement before you trust either side.

## Before you start

- Get `kubectl` access to offsite ([Get cluster admin access](get-cluster-admin-access.md)).
- For a replay, have the key of the candidate's provider. An OpenCode Go candidate reads `OPENCODE_API_KEY`, which is the `password` of the `opencode api key` item in the `homelab` vault. Any other provider reads a pi-ai credential from the JSON file `MATE_EVALS_CREDENTIALS_FILE`, keyed by provider id; the replay refreshes an OAuth credential in place. Never use Rowbutt's own ChatGPT sign-in: mate refreshes that token, and a second refresher breaks it.
- A replay spends the candidate's tokens: each decision sends the thread's whole context so far.

## Read the store

1. Reach `mate-db` from the workstation.

   ```bash
   kubectl --context offsite -n mate port-forward svc/mate-db-rw 15433:5432 &
   sleep 2
   ```

2. Build the URL from the owner role's password, without printing it.

   ```bash
   password="$(kubectl --context offsite -n mate get secret mate-db-app -o jsonpath='{.data.password}' | base64 -d)"
   export MATE_EVALS_DATABASE_URL="postgres://mate:${password}@127.0.0.1:15433/mate?sslmode=require"
   unset password
   ```

   `sslmode=require` asks for TLS without checking the certificate, which a port-forward to the CloudNativePG pod needs. The owner role can write, so the evals open their one connection read-only with `SET default_transaction_read_only = on` and run only SELECTs; the role's password is letters and digits, so it needs no URL encoding. The nightly dump in `gs://homelab-ng-mate/backups/pg/` restored into a local Postgres works the same way, with that database's URL, and reads nothing live.

## Read the ledger

1. Run the evals over the last week.

   ```bash
   cd apps/mate && bun run evals -- --since 7d
   ```

   Result: one row per `provider/model` that answered a step, with its steps, tool calls, tool results that failed, steps that ended in an error or were aborted, the median time from the message before a step to the step, and the cost pi-ai priced. `--profile custodian` keeps one profile's threads, and `--json` prints the same as JSON.

## Replay the decisions

1. Export the candidate's key, then name the candidate.

   ```bash
   export OPENCODE_API_KEY="$(op read 'op://homelab/opencode api key/password')"
   bun run evals -- --since 7d --model opencode-go/qwen3.8-max --decisions 40
   ```

   Result: a second table with, for each candidate, the decisions replayed, how many it answered, the share that chose the same tool, the share that chose the same action, how many answered with text and no tool, how many errored, and the cost. Under it, one line per disagreement with the thread's key and the step, so the thread can be read. `--model` repeats for several candidates, `--thinking` sets the candidate's reasoning level, and `--decisions` bounds the sample, which takes the newest decision of each thread in turn. A step that called several tools at once is scored by its first call, and the context the candidate sees is the one pi sent for the step: after a compaction, the summary and what it kept, not the whole history.

2. Decide. A candidate that agrees on most actions, answers with no tool rarely and costs less is a fair default; one that errors or answers with text where the recorded model called a tool is not ready. Change `MATE_MODEL`, `MATE_THINKING`, `MATE_FALLBACK_MODEL` or `MATE_FALLBACK_THINKING` in `clusters/offsite/apps/mate/deployment.yaml` through a pull request, and read [Operate the Rowbutt model fallback](operate-the-rowbutt-model-fallback.md) for what each pair means.

## Where it lives

- `apps/mate/src/evals.ts`: the ledger, the decisions, the sample, the replay and the tables
- `apps/mate/src/evals-cli.ts`: `bun run evals`, its flags and the credential file
- `docs/apps/mate/how-it-works.md#session-store`: the tables the evals read
