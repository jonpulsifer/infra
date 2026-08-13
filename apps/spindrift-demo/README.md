# spindrift-demo

Five scopes, one per shape of App worth demonstrating. Each is a directory you
can point a Component at, and no scope imports another — railpack builds with
the *scope* as its context, so a module one directory up is not in the build.

| Scope | Kind | Built by | What it demonstrates |
| --- | --- | --- | --- |
| `src/` | website | Dockerfile | A site with a real build step. `build.ts` stamps commit, branch and time into the HTML, so a stale deploy is visible on the page. |
| `plain/` | website | — | Static files with no build at all. The narrowest possible website. |
| `railpack/` | service | railpack | Detection picking a frontend on its own, because there is no Dockerfile in the scope. |
| `job/` | job | railpack | A Component that runs once and stops, on either backend. Writes to a `valkey` Datastore when one is attached. |
| `web/` | service | railpack | Reads back what `job/` wrote. The two are a **pair**, and the only shared thing is a Datastore. |

Four of them prove something about exactly one path. `job/` and `web/` are the
exception and the reason is [below](#the-pair) — they share no code and name
each other nowhere, and that is the thing being demonstrated.

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
`/env` as a names-plus-curated-safe-values inspection endpoint. `job/` logs
its backend identity and `SPINDRIFT_BUILD` at the start of every execution.

## Why two of them carry no `spindrift.yaml` and one does

`job/` has to declare itself. Detection infers only `service` and `website` —
`Exclude<ComponentKind, 'job'>` in
`apps/spindrift/src/domain/detection/ladder.ts` — because nothing about a tree
of files says whether it should be served or run once. `railpack/` deliberately
has no such file: it is the demo of detection choosing for itself, and a file
asserting the answer would remove the thing being demonstrated.

`buildkit.ts` switches frontends on `[ -f Dockerfile ]` **in the scope**, so
`railpack/` and `job/` staying Dockerfile-free is what routes them through
railpack. Both are also self-contained — no workspace dependency, no root
lockfile — because the zero-config arm builds with the scope as its build
context rather than the repository root.

## `job/`

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

`job/` writes and `web/` reads, and nothing connects them. Put both in **one
App**, attach one `valkey` Datastore to that App, and deploy: each Component is
handed the same `REDIS_URL`, because a Datastore attaches to the App and its
variable name is fixed by the engine — `REDIS_URL` for valkey, `DATABASE_URL`
for postgres (`apps/spindrift/src/domain/desired-state.ts`). Neither scope
declares a store and neither names the other. There is nothing to wire.

Three things it is worth watching for, in order:

1. **Before an attach**, `web/` says no Datastore is attached, in those words.
   It is not an error state — it is what every Component looks like until one
   is attached.
2. **Straight after an attach**, the page has not changed. An attach is
   bookkeeping; the variable reaches a workload on its **next Deploy**, because
   "an attach that silently rolled every Component would be a destructive act
   hiding behind a bookkeeping verb" (`commands/datastores/attach.ts`).
3. **After deploying**, the counter and the run table appear. Press **Run now**
   on `job/` and the page picks the new row up within five seconds.

One store per engine per App, refused at attach: a second `valkey` would claim
the same `REDIS_URL` and win by ordering. One valkey *and* one postgres is
fine, since those are two different variables.

Datastores are provisionable on **Kubernetes** Targets only — the GCP adapter
claims both engines and throws `UNIMPLEMENTED` from every verb, because a
Vessel carries no network to place a private endpoint in. The same `job/` image
on Cloud Run finds no `REDIS_URL` and says so rather than failing, which is why
that path still demonstrates what it is there to demonstrate.

`web/` has to be a `service`. A `website` is static files served by the Target
— no process, no environment — so no connection string can reach one; `src/`
and `plain/` are that side of the line.

## Running them locally

```
cd railpack && npm run build && npm start     # :3000, JSON on /, /healthz, /env
cd job && DURATION_SECONDS=3 npm start        # exits 0
cd job && EXIT_CODE=7 npm start               # exits 7, writes to stderr
cd web && npm test                            # the RESP reader's own check
```

The pair, against a local valkey:

```
valkey-server --port 16379 --save ''
cd job && REDIS_URL=redis://127.0.0.1:16379 DURATION_SECONDS=2 npm start
cd web && REDIS_URL=redis://127.0.0.1:16379 npm start    # :3000
```

Start `web/` with no `REDIS_URL` to see the unattached state, or point it at a
port nothing is listening on to see the unreachable one. `/healthz` stays green
through both — this Component is up whether or not a store is.

`bun run dev` from this directory builds `src/` and serves it hot through
`serve.ts`. `plain/` is a static directory; point a static-file host at it to
exercise the client-only identity surface.
