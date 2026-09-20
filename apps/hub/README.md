# Weather Hub

The TempestWx dashboard. One layout serves two displays: the 800×480 touch
panel the kiosk Pis drive (`nix/services/kiosk.nix` points Firefox at
`https://hub.lolwtf.ca`), and a phone with the app installed from the same URL.

## How it works

The server polls the WeatherFlow REST API for the latest observation of every
station reachable with the configured tokens (one request per station every
30s, regardless of how many displays are watching) and caches an in-memory
snapshot. Clients fetch the snapshot from `/api/weather` on the same cadence.
Stations report new observations roughly once a minute, so the display is at
most ~30s behind the station.

Alongside that, a slower loop (every 5 minutes) fetches each station's raw
device observations for the last 24 hours and reduces them to a per-metric low
and high plus a downsampled temperature series. That needs the `device_id` the
station list reports, not the station id, and the rows come back as positional
arrays whose field order depends on the device type — `app/lib/weatherflow/history.ts`
holds the index maps and is where `test/history.test.ts` points.

Each build bakes a build ID into both the server and client bundles, and the
snapshot includes the server's ID. Kiosk browsers (which never navigate on
their own) reload themselves when the IDs stop matching, so long-running
displays pick up new deployments within one poll interval.

## Features

- **Now and the last 24 hours**: current reading per station, where it sits in
  the day's range, and a low/high on every metric.
- **Station comparison**: each station keeps one identity colour, and with two
  of them the headline carries the temperature difference.
- **Installable**: a web manifest, icons and an offline shell (`/sw.js`, served
  from a route so its cache name carries the build ID). Documents and
  `/api/weather` are network-first, so a kiosk still picks up a deployment
  immediately and only falls back to the cache when its wifi drops.
- **Kiosk mode**: fixed to the viewport at 800×480, scrolling on a phone.
- **Container friendly**: includes endpoints for process management (e.g.
  restart via `api.exit`).

## Tech Stack

- **Framework**: [React Router 8](https://reactrouter.com/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Icons**: [Lucide React](https://lucide.dev/)

## Getting Started

### Prerequisites

- Bun
- TempestWx API token

### Installation

1. Install dependencies from the repo root:
   ```bash
   bun install
   ```
2. Create a `.env` file with your TempestWx token:
   ```env
   TEMPESTWX_TOKENS=your_token_here
   # Optional: comma-separated station IDs to ignore
   TEMPESTWX_IGNORE_STATIONS=85191
   ```

### Development

```bash
bun run dev
```

The dev server never calls WeatherFlow: `app/lib/weatherflow/mock.ts` generates
stations, observations and 24h windows locally, and a floating control adds and
removes them. The whole mock path is behind `import.meta.env.DEV`, so it is
tree-shaken out of production bundles.

### Build and test

```bash
bun run build
bun run test
```

### Icons

`public/*.png` are generated, not hand-drawn. After changing the mark:

```bash
bun run apps/hub/scripts/icons.ts
```
