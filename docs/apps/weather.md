---
title: Weather API
description: An API on offsite that answers Canadian weather questions from Environment Canada and the family's Tempest stations, for apps and for Rowbutt.
status: live
---

The Weather API answers weather questions for any place in Canada. It combines the Meteorological Service of Canada's (MSC) open data at `api.weather.gc.ca` with the family's WeatherFlow Tempest stations, the ones the [Weather Hub](hub.md) shows. [Rowbutt](mate.md) calls it as tools, and apps call it over HTTP.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Tools | The `weather_*` tools in Rowbutt | Anyone who talks to Rowbutt |
| MCP | `https://weather.<tailnet>/mcp`, and `http://weather.weather.svc.cluster.local:8080/mcp` in the cluster | The owner over the tailnet, and mate's bot pod |
| HTTP | `GET /v1` lists the operations, and `GET /v1/<operation>` runs one | Same as MCP |

`<tailnet>` is the tailnet name in `terraform/network/tailscale/fleet.tf.json`. A question with no place goes to home, the first entry of `WEATHER_PLACES`. A place is a configured name, a Tempest station, a Canadian town, or `lat,lon`. Answers are metric, and times are in the place's zone.

The operations are current conditions, forecast, alerts, Tempest history, daily climate, records and normals, air quality, tropical storms, marine forecasts, and Nova Scotia burn restrictions. `operations` in `apps/weather/src/operations.ts` lists them with their parameters.

## Limits

- A place's official readings come from the station its weather.gc.ca city page reads, which can be 30 km or more away. Tempest stations count only within 30 km.
- Daily climate lags a day or two behind today.
- MSC and WeatherFlow answers are cached for one to thirty minutes, depending on how often each source changes.
- Burn restrictions cover Nova Scotia alone. `apps/weather/src/burnsafe.ts` parses the BurnSafe page, which has no API.

## How it works

One Bun process serves both surfaces from one registry of operations. MCP runs stateless, one server per request, so any replica answers. Every upstream request has a timeout and a cache in `apps/weather/src/upstream.ts`.

The `weather-env` ExternalSecret reads `TEMPESTWX_TOKENS` from the 1Password item the hub uses. The Deployment has no gateway. A Tailscale operator Ingress puts it on the tailnet, and its CiliumNetworkPolicy admits only mate, the tailnet proxy, and egress to the three upstreams.

## Operate

No alert rule is specific to the Weather API. `GET /healthz` is the readiness probe. An `errors` list in an answer names each source that failed, while the rest of the answer stands.

## Reference

- Source: `apps/weather/`
- Manifests: `clusters/offsite/apps/weather/`
- Places: `WEATHER_PLACES` in `clusters/offsite/apps/weather/deployment.yaml`
- Agent notes: `.agents/skills/weather/SKILL.md`
- Image: `ghcr.io/jonpulsifer/weather`
