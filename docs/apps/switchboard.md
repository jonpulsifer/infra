---
title: Switchboard
description: A Bun service that rings the owner's phone through an ElevenLabs voice agent. Built, not deployed.
status: parked
---

Switchboard places one outbound call at a time: ElevenLabs dials the owner's
cell over voip.ms and hands the call to a conversational agent. No cluster
runs it yet, so nothing reaches it today.

## How it works

Switchboard answers `POST /ring`, `POST /alertmanager` and `GET /healthz`.
Each caller class carries its own bearer token, a daily cap on attempts and a
cooldown between calls, so a stuck key or a repeated alert cannot run up the
bill. `/ring` takes a short reason and rings the number in
`SWITCHBOARD_TO_NUMBER`; nothing in the request can choose a different one.
`/alertmanager` takes an Alertmanager webhook, calls only for a firing
`critical` alert outside quiet hours, skips the synthetic `Watchdog` alert,
and dedupes by fingerprint so a repeated notification does not ring twice.

At boot, switchboard lists the ElevenLabs agents and keeps the id of the one
named `SWITCHBOARD_AGENT_NAME`, `pbx-switchboard` by default. No agent of that
name, or two of them, is a config error, and the process exits with status 64.
`SWITCHBOARD_AGENT_ID` skips the lookup.

Every call goes to ElevenLabs' outbound-call endpoint, bounded by a timeout
and never retried: a redial is a decision for whoever calls switchboard, not
switchboard itself. It logs an outcome and never the destination number, a
URL, a request body or a token.

## Reference

- Source: `apps/switchboard/`
- Image: `ghcr.io/jonpulsifer/switchboard`, built by `.github/workflows/containers.yml`
