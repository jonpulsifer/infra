---
title: Weather Hub
description: A web dashboard on offsite that shows the owner's WeatherFlow Tempest weather stations, on the kiosk displays and on phones.
status: live
---

The Weather Hub is a web dashboard for the owner's WeatherFlow Tempest weather stations. A Tempest station reports its readings to WeatherFlow's cloud. The `hub` app on the offsite [Kubernetes](../platform/kubernetes.md) cluster reads them from that cloud. The kiosk displays on [homepi4](../hosts/homepi4.md) and [weatherpi4](../hosts/weatherpi4.md) show the hub full-screen, and phones install it as a web app.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Dashboard | `https://hub.lolwtf.ca` | Clients that route to offsite's load-balancer range, with no sign-in |
| Kiosks | The displays of homepi4 and weatherpi4 | People at the displays |
| Snapshot API | `GET https://hub.lolwtf.ca/api/weather` | Same as the dashboard |

The dashboard shows each station's current readings against their 24-hour low and high. With two stations, the headline shows the temperature difference between them. A station that `BURNSAFE_COUNTIES` places in a county also shows that county's fire restriction for the day.

## Limits

- The dashboard is up to about a minute behind WeatherFlow. The 24-hour lows and highs refresh every 5 minutes.
- The Restart App item in the refresh menu restarts the server, and it needs no sign-in. Anyone who can reach the dashboard can use it.
- The hub hides the station IDs in `TEMPESTWX_IGNORE_STATIONS` in the HelmRelease.
- The fire restriction is up to 10 minutes behind [BurnSafe](https://novascotia.ca/burnsafe/). BurnSafe has no API, so a change to the page's county table hides the restriction until the parser in `apps/hub/app/lib/burnsafe.ts` follows it.

## How it works

One server process polls the WeatherFlow REST API every 30 seconds. It reads the latest observation of each station that the tokens in `TEMPESTWX_TOKENS` can read, and caches one snapshot. The traffic to WeatherFlow does not grow with the number of displays. Clients fetch the snapshot from `/api/weather` every 30 seconds.

A second loop reads the BurnSafe page every 10 minutes. `BURNSAFE_COUNTIES` in the HelmRelease maps each station ID to a county, and `/api/weather` carries each mapped station's restriction. When the variable is unset, the hub does not fetch the page.

Each build has a build ID, and the snapshot carries the server's build ID. When the two build IDs differ, the page reloads itself, at most once every 5 minutes. A kiosk shows a new deploy with no restart. The service worker at `/sw.js` serves the last cached page when the network drops.

Flux deploys the hub with the first-party `app` Helm chart, which gives it its own Gateway. The `hub-env` ExternalSecret reads `TEMPESTWX_TOKENS` from 1Password.

## Operate

No alert rule is specific to the hub. The default kube-prometheus-stack rules on offsite cover its pod. If a kiosk shows an error page or a blank screen, see [Repair a kiosk](../runbooks/repair-a-kiosk.md).

## Reference

- Source: `apps/hub/`
- Manifests: `clusters/offsite/apps/hub/`
- Chart: `packages/charts/app/`
- Kiosk URL: `hubUrl` in `nix/lib/fleet.nix`
- Image: `ghcr.io/jonpulsifer/hub`
