---
name: weather
description: >-
  Answer weather questions for a Canadian place or the family's Tempest
  stations through the Weather API: current conditions, forecasts, alerts,
  station history, climate, records, air quality, tropical storms, marine
  forecasts and Nova Scotia burn bans. Use when anyone asks about the weather,
  rain, wind, frost, storms, or whether to burn, even with no place named.
metadata:
  wiki: https://wiki.lolwtf.ca/apps/weather/
---

# Weather

The service page is `docs/apps/weather.md`. These notes cover what an agent
needs beyond it.

## Reach it

- If the session lists the weather server's tools, call them directly. The
  tool names below are the server's own: Rowbutt names them `weather_<tool>`,
  and pi names them `mcp__weather__<tool>`.
- Anywhere else, use HTTP on the tailnet. `<tailnet>` is `locals.fleet.tailnet` in
  `terraform/network/tailscale/fleet.tf.json`:

  ```bash
  curl -sS --max-time 60 "https://weather.<tailnet>/v1"   # the operations
  curl -sS --max-time 60 "https://weather.<tailnet>/v1/forecast?place=halifax&hours=6"
  ```

  To give Claude Code the tools: `claude mcp add --transport http weather https://weather.<tailnet>/mcp`.
- Tool `current_conditions` is `GET /v1/current-conditions`; every tool maps
  the same way, with its arguments as query parameters.

## Pick the call

| Question | Call |
| --- | --- |
| What is it like now, is it windy, any lightning | `current_conditions` |
| Will it rain, what about the weekend, hour by hour | `forecast` (`hours` up to 24) |
| Any warnings | `alerts`; with no place it checks every configured place |
| How much rain fell here, what was the low last night | `tempest_history` (up to 240 hours) |
| Last week or last year, official | `climate` (`from`, `to`) |
| Is this unusual, a record | `records` |
| Smoke, air quality | `air_quality` |
| Hurricanes, tropical storms | `hurricanes` |
| Boating, on the water | `marine_forecast` |
| Can I burn today (Nova Scotia) | `burn_restrictions` (`county`) |

With no place, a call answers for home, the first name in `WEATHER_PLACES`.
`places` lists the configured names and the Tempest stations. A person's
own words for a place, such as a town, "lat,lon" or a station name, work
as the place.

## Answer well

- Lead with what the person asked. Quote the forecast period's own words
  when it answers the question, and give the numbers with units.
- Say which source a number comes from when two disagree: the official
  station, or a family Tempest station nearer the house.
- Wind is km/h, except hurricanes, which are in knots. Times are already
  local to the place.
- An `errors` list names the sources that failed; the rest of the answer
  stands. Mention a gap only if it matters to the question.
- Canada only: MSC has no forecast for other countries. Say so, and do not
  guess.
