# spindrift-demo

Four scopes, one per shape of App worth demonstrating. Each is a directory you
can point a Component at; nothing here shares code with anything else here, so
deploying one proves something about exactly one path.

| Scope | Kind | Built by | What it demonstrates |
| --- | --- | --- | --- |
| `src/` | website | Dockerfile | A site with a real build step. `build.ts` stamps commit, branch and time into the HTML, so a stale deploy is visible on the page. |
| `plain/` | website | — | Static files with no build at all. The narrowest possible website. |
| `railpack/` | service | railpack | Detection picking a frontend on its own, because there is no Dockerfile in the scope. |
| `job/` | job | railpack | A Component that runs once and stops, on either backend. |

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

## Running them locally

```
cd railpack && npm run build && npm start     # :3000, JSON on /, /healthz, /env
cd job && DURATION_SECONDS=3 npm start        # exits 0
cd job && EXIT_CODE=7 npm start               # exits 7, writes to stderr
```

`src/` and `plain/` are served by the `serve.ts` beside them; `bun run dev`
from this directory builds `src/` and serves it hot.
