# TempestWx Weather Hub

A weather station dashboard designed for the Raspberry Pi 4 display, powered by TempestWx.

## How it works

The server polls the WeatherFlow REST API for the latest observation of every
station reachable with the configured tokens (one request per station every
30s, regardless of how many displays are watching) and caches an in-memory
snapshot. Clients fetch the snapshot from `/api/weather` on the same cadence.
Stations report new observations roughly once a minute, so the display is at
most ~30s behind the station.

Each build bakes a build ID into both the server and client bundles, and the
snapshot includes the server's ID. Kiosk browsers (which never navigate on
their own) reload themselves when the IDs stop matching, so long-running
displays pick up new deployments within one poll interval.

## Features

- **Weather Data**: Latest conditions per station, with a per-station freshness indicator.
- **Station Comparison**: With exactly two stations, a center column shows the field-by-field difference.
- **Kiosk Mode**: Optimized for running as a dedicated display on Raspberry Pi 4.
- **Container Friendly**: Includes endpoints for process management (e.g., restart via `api.exit`).

## Tech Stack

- **Framework**: [React Router 7](https://reactrouter.com/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Icons**: [Lucide React](https://lucide.dev/)

## Getting Started

### Prerequisites

- Node.js or Bun
- TempestWx API Token

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Create a `.env` file with your TempestWx token:
   ```env
   TEMPESTWX_TOKENS=your_token_here
   # Optional: comma-separated station IDs to ignore
   TEMPESTWX_IGNORE_STATIONS=85191
   ```

### Development

Run the development server:

```bash
bun run dev
```

### Build

Build for production:

```bash
bun run build
```
