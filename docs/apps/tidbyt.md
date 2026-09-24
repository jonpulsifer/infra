---
title: Tidbyt apps
description: Four Pixlet apps, rackstat, tempest, wishin and callerid, that the Tronbyt server on folly renders for the lab's Tidbyt pixel displays.
status: live
---

The Tidbyt apps are four Pixlet apps, rackstat, tempest, wishin and callerid, that draw screens on the lab's Tidbyt displays for the owner. A Tidbyt is an LED display of 64 by 32 pixels, and Pixlet renders its Starlark apps. Tronbyt, a self-hosted Tidbyt server on the folly [Kubernetes](../platform/kubernetes.md) cluster, renders the installed apps and serves the images to each display.

## Apps

| App | Shows | Data |
| --- | --- | --- |
| `apps/rackstat/` | Lab health: firing alerts, nodes, Flux sync, network probes and 24 hours of cluster CPU. Problem screens show first. | The rackstat aggregator, a Go service in the same directory |
| `apps/tempest/` | One Tempest weather station: current conditions, a 3-day forecast and a 24-hour temperature graph | WeatherFlow's forecast API, with a station ID and token set in Tronbyt |
| `apps/wishin/` | The gift, user and claimed counts of wishin.app | `https://www.wishin.app/api/stats` |
| `apps/callerid/` | An incoming call: a name or number, a SPAM screen, or a troll screen | A `name`/`number`/`verdict` config passed in by whatever pushes to it |

`apps/wishin/` holds only the display app. wishin.app, a gift wishlist site, is a separate project on Vercel.

rackstat, tempest and wishin fetch their own data on Tronbyt's render schedule. callerid renders only its config, so something has to push it: Tronbyt's `push_app` API renders a named app with a config and sends the image to a device. Nothing calls that endpoint for callerid yet, so with no `number` set it cycles a demo of every verdict instead.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Tronbyt web UI | `https://tronbyt.lolwtf.ca` | Clients that route to folly's load-balancer range, with a Tronbyt sign-in. New users cannot register. |
| rackstat snapshot | `http://rackstat.tronbyt:8080/api/rackstat` | Pods in folly |

Tronbyt keeps in its database which apps each display shows. Git does not record it.

## Limits

- Pixlet rejects a `load()` outside the app directory, so each app carries its own helpers.
- If an API answers with an error status or incomplete data, the app draws a screen that names the error. If the API cannot be reached, the render fails.
- rackstat shows `STALE` when its snapshot has errors or is older than 5 minutes. Its header clock comes from the cluster, so a frozen clock means Tronbyt or folly is down.
- callerid takes no API errors: a malformed `number` or an unknown `verdict` falls back to plain digits or the `ring` screen instead of failing the render.

## How it works

Tronbyt runs the `ghcr.io/tronbyt/server` image, with a CloudNativePG database and an NFS volume from spore.

The rackstat aggregator runs in the `tronbyt` namespace. It merges Prometheus data, the Flux Kustomization and HelmRelease objects, and TCP probe results into one JSON snapshot. It caches the snapshot for 15 seconds. The `rackstat-flux-reader` ClusterRole gives it read access to the Flux objects. `PROBES` in `clusters/folly/apps/tronbyt/07-rackstat-deployment.yaml` names the probe targets. `rackstat.star` reads the snapshot from `http://rackstat:8080/api/rackstat` in the same namespace.

On a pull request, the `pixlet-preview` workflow posts a render of each changed app.

## Operate

No alert rule is specific to the displays or Tronbyt. The default kube-prometheus-stack rules on folly cover their pods.

## Reference

- Source: `apps/rackstat/`, `apps/tempest/`, `apps/wishin/` and `apps/callerid/`
- Manifests: `clusters/folly/apps/tronbyt/`
- Images: `ghcr.io/jonpulsifer/rackstat` and `ghcr.io/tronbyt/server`
- Previews: `.github/workflows/pixlet-preview.yml`
