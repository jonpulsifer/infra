# Weather Hub

Weather Hub is a React Router app that shows the latest readings of the
TempestWx weather stations. It serves the 800×480 kiosk displays and phones
from one layout. See [Weather Hub](https://wiki.lolwtf.ca/apps/hub/).

## Run

```bash
bun install          # once, at the repo root
bun run dev
```

The dev server makes no call to WeatherFlow. `app/lib/weatherflow/mock.ts`
makes the stations and readings, and a control on the page adds and removes
them. The mock is behind `import.meta.env.DEV`, so production bundles do not
contain it.

In production, the server reads these variables:

| Variable | Meaning |
| --- | --- |
| `TEMPESTWX_TOKENS` | WeatherFlow API tokens. The server polls each station these tokens reach. |
| `TEMPESTWX_IGNORE_STATIONS` | Optional. Comma-separated station ids to skip. |
| `BURNSAFE_COUNTIES` | Optional. `<station id>=<county>` pairs, comma-separated. Each mapped station shows that county's fire restriction. |

## Code

- `app/services/weather.server.ts` polls the latest observation of each station
  every 30 seconds and keeps a snapshot in memory. Clients read it from
  `/api/weather`.
- `app/services/burnsafe.server.ts` reads `https://novascotia.ca/burnsafe/`
  every 10 minutes. The page has no API, so `app/lib/burnsafe.ts` parses its
  county table.
- `app/lib/weatherflow/history.ts` reduces the device observations of the last
  24 hours to lows, highs and a temperature series. The rows are positional
  arrays, and the field order depends on the device type.
- The server and the client bundles each carry a build id. A client reloads
  itself when the id in the snapshot differs from its own.
- `app/routes/api.exit.ts` stops the process when a client requests `/api/exit`,
  so the container restarts.

## Build and test

```bash
bun run build
bun run test
bun run typecheck
bun run lint
```

`scripts/icons.ts` generates `public/*.png`. After a change to the mark, run
`bun run apps/hub/scripts/icons.ts` from the repo root.

## Deploy

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/hub`. Flux
applies `clusters/offsite/apps/hub/`, which installs `packages/charts/app` at
`https://hub.lolwtf.ca`. The kiosk Pis open that address through
`nix/profiles/pi4-kiosk.nix`.
