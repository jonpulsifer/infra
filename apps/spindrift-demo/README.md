# spindrift-demo

Four scopes, one per shape of App worth demonstrating. **A scope is an App** —
`sourceRepoSubpath` is a column on `apps`, not on `components`
(`apps/spindrift/src/db/schema.ts`) — and no scope imports another, because
railpack builds with the scope as its context and a module one directory up is
not in the build.

| Scope | Components | Built by | What it demonstrates |
| --- | --- | --- | --- |
| `src/` | one website | Dockerfile | A site with a real build step. `build.ts` stamps commit, branch and time into the HTML, so a stale deploy is visible on the page. |
| `plain/` | one website | — | Static files with no build at all. The narrowest possible website. |
| `railpack/` | one service | railpack | Detection picking a frontend on its own, because there is no Dockerfile in the scope. |
| `pair/` | a service **and** a job | railpack | One App with two Components: one image, two entrypoints, sharing a `valkey` Datastore that neither of them declares. |

Three of them prove something about exactly one path. `pair/` is the exception
and the reason is [below](#the-pair) — it is the only scope here that is more
than one Component.

## Runtime identity

The demos show facts that change with a rollout instead of a simulated fleet.
`src/` receives server facts from `serve.ts` and shows the hosting platform,
hostname, process start time and uptime, build identity, a curated set of safe
platform environment variables, and the browser's own facts. The same JSON is
available at `/__runtime__`; `/healthz` is the cheap liveness answer.

`plain/` is deliberately different: a CDN serving static files has no process
or `process.env` to inspect. It identifies Firebase Hosting, Cloudflare Pages,
Vercel, and Cloud Run from the requested hostname and shows client facts, then
states that server facts do not exist for that scope.

The platform mark and detection signal are:

| Platform | Signal | Mark |
| --- | --- | --- |
| Firebase App Hosting | `FIREBASE_CONFIG` plus `K_SERVICE` | Firebase |
| Google Cloud Run | `K_SERVICE`, `K_CONFIGURATION`, `K_REVISION`, or `CLOUD_RUN_JOB` | Google Cloud |
| Kubernetes | `KUBERNETES_SERVICE_HOST` | Kubernetes |
| Cloudflare Pages | `CF_PAGES`, or a `*.pages.dev` hostname | Cloudflare |
| Vercel | `VERCEL` or `VERCEL_ENV`, or a `*.vercel.app` hostname | Vercel |
| AWS | `AWS_EXECUTION_ENV`, `ECS_CONTAINER_METADATA_URI_V4`, or `AWS_REGION` | AWS |

The demo carries marks for every platform above, plus Cloudflare Workers for a
Workers deployment. A custom static domain with no matching hostname or server
marker renders a generic globe instead of making a guess.

`Dockerfile` exposes its `BUILD_COMMIT` build argument at runtime as
`SPINDRIFT_BUILD`. Supply a source revision for that argument when a SHA is
available; the page also carries its baked commit, branch, and build timestamp.
`SPINDRIFT_RUNTIME_LABEL` is an optional runtime variable for deliberately
proving that a configuration change reached a new process. Only the curated
platform identifiers and those two `SPINDRIFT_*` values are rendered; arbitrary
configuration, secrets, Firebase config, and the Kubernetes service address
never reach the page.

`railpack/` reports the same server identity in its `/` JSON and exposes
`/env` as a names-plus-curated-safe-values inspection endpoint. `pair/job.js`
logs its backend identity and `SPINDRIFT_BUILD` at the start of every
execution.

## Why only one of them carries a `spindrift.yaml`

The root scope declares its Dockerfile frontend. Nothing below it declares
anything, and each absence says something different.

`railpack/` is the demo of detection choosing for itself, so a file asserting
the answer would remove the thing being demonstrated. `pair/` has no single
answer to assert: `component.kind` in that file is one value
(`apps/spindrift/src/domain/detection/spindrift-file.ts`) and the scope carries
a service and a job. Detection could not have proposed the job half anyway —
it infers only `service` and `website`, `Exclude<ComponentKind, 'job'>` in
`apps/spindrift/src/domain/detection/ladder.ts`, because nothing about a tree
of files says whether it should be served or run once. So the kind is named per
Component, at creation, which is where it belonged.

`buildkit.ts` switches frontends on `[ -f Dockerfile ]` **in the scope**, so
`railpack/` and `pair/` staying Dockerfile-free is what routes them through
railpack. Both are also self-contained — no workspace dependency, no root
lockfile — because the zero-config arm builds with the scope as its build
context rather than the repository root.

## `pair/job.js`

Three optional env vars, so one image covers every case worth looking at:

| Variable | Default | Effect |
| --- | --- | --- |
| `DURATION_SECONDS` | `15` | How long the run takes. Long enough to watch it go from started to finished; short enough that a `*/5 * * * *` schedule never overlaps itself. |
| `EXIT_CODE` | `0` | Set it non-zero to see how a failed run surfaces. It writes to stderr on the way out. |
| `STEPS` | `5` | How many progress lines to emit, spread across the duration. |

It prints which backend it landed on from the environment it was given —
`CLOUD_RUN_EXECUTION` on Cloud Run, `HOSTNAME` on Kubernetes — so a single run
says which adapter placed it without anyone opening the UI.

A cadence is not declared here. The same code is a job you press **Run now** on
and a job that fires every five minutes; which one it is belongs to the
Component, chosen at Place, not to the directory.

## The pair

One App on `pair/`, two Components, and nothing connecting them but a store
neither one declares.

Create the App on the scope: railpack detects `scripts.start`, so the image's
own entrypoint is `node server.js` and the **service** Component runs it by
saying nothing. Then add a second Component from the App workspace — kind
`job`, entrypoint `node job.js`. That is the whole of the difference between
them: same scope, same image, same digest, two workloads. An App is one scope
(`sourceRepoSubpath` is a column on `apps`), so a sibling Component is never a
second directory — it is a second way of running the first one, which is what
`components.command` is for.

Attach one `valkey` Datastore to the App and deploy. Both Components are handed
the same `REDIS_URL`, because a Datastore attaches to the App and its variable
name is fixed by the engine — `REDIS_URL` for valkey, `DATABASE_URL` for
postgres (`apps/spindrift/src/domain/desired-state.ts`). Neither entrypoint
declares a store and neither names the other. There is nothing to wire.

Three things it is worth watching for, in order:

1. **Before an attach**, the page says no Datastore is attached, in those
   words. It is not an error state — it is what every Component looks like
   until one is attached.
2. **Straight after an attach**, the page has not changed. An attach is
   bookkeeping; the variable reaches a workload on its **next Deploy**, because
   "an attach that silently rolled every Component would be a destructive act
   hiding behind a bookkeeping verb" (`commands/datastores/attach.ts`).
3. **After deploying**, the counter and the run table appear. Press **Run now**
   on the job Component and the page picks the new row up within five seconds.

One store per engine per App, refused at attach: a second `valkey` would claim
the same `REDIS_URL` and win by ordering. One valkey *and* one postgres is
fine, since those are two different variables.

Datastores are provisionable on **Kubernetes** Targets only — the GCP adapter
claims both engines and throws `UNIMPLEMENTED` from every verb, because a
Vessel carries no network to place a private endpoint in. The same image on
Cloud Run finds no `REDIS_URL` and says so rather than failing, which is why
that path still demonstrates what it is there to demonstrate.

The reading half has to be a `service`. A `website` is static files served by
the Target — no process, no environment — so no connection string can reach
one; `src/` and `plain/` are that side of the line.

## Running them locally

```
cd railpack && npm run build && npm start          # :3000, JSON on /, /healthz, /env
cd pair && DURATION_SECONDS=3 npm run job          # exits 0
cd pair && EXIT_CODE=7 npm run job                 # exits 7, writes to stderr
cd pair && npm test                                # the RESP reader's own check
```

The pair, against a local valkey — the two `npm` scripts are the two
entrypoints the two Components run:

```
valkey-server --port 16379 --save ''
cd pair && REDIS_URL=redis://127.0.0.1:16379 DURATION_SECONDS=2 npm run job
cd pair && REDIS_URL=redis://127.0.0.1:16379 npm start    # :3000
```

Start it with no `REDIS_URL` to see the unattached state, or point it at a port
nothing is listening on to see the unreachable one. `/healthz` stays green
through both — this Component is up whether or not a store is.

`bun run dev` from this directory builds `src/` and serves it hot through
`serve.ts`. `plain/` is a static directory; point a static-file host at it to
exercise the client-only identity surface.
