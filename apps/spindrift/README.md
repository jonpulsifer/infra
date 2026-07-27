# spindrift

Connect a repo, press Deploy, get a URL.

Spindrift is a deploy layer, not a platform: it owns the UI and the feel, and
adapts to whatever builds and delivers underneath — a Kubernetes cluster, Cloud
Run, or static hosting. The design lives in `.agent/plans/spindrift/spec.md`
(private) and is referenced from the source as `§N`.

**An uploaded bundle reaches a Kubernetes cluster and comes back with a URL.**
The five nouns have tables, the three adapter contracts are written, and
commands are the only way anything is acted on. Targets can be connected,
inspected on a loop, and resolved against — asking where a Component can go
returns an answer with a reason for every Target it cannot. Uploading finished
output records an artifact without a builder; creating a Deploy writes an intent
under a locking read; the reconciler claims that intent, applies it through the
Kubernetes adapter, and records what the platform said.

What has no implementation is the Cloud Run and static deploy adapters, every
real build route, config delivery, and datastores. **The three screens still
render placeholder data** from `src/web/demo/`, which is scaffolding meant to be
deleted: the views are typed against `src/web/model.ts`, so the query commands
that replace it have a contract to meet rather than a shape to guess.

Three named gaps, all deliberate:

- **Nobody can sign in.** Passkey enrolment and sessions are unbuilt, so every
  command route answers 401. The boundary is complete and rejects everything,
  rather than carrying a development bypass that would become permanent.
- **The creation draft is client state**, so a refresh mid-flow loses it. It
  wants a table and a pair of commands, which belong with the App and Component
  commands rather than in front of them.
- **The status page is not served yet.** §9 wants a URL that resolves from the
  moment an App exists, on a lowest-precedence wildcard route. Naming is here and
  a deployed Component's names resolve through its route; the wildcard route and
  the page it points at are not, so an App's address stays dark until something
  has actually been deployed to it.

## Shape

One image, two processes (§19); only `web` exists so far.

| Path | What it is |
| --- | --- |
| `src/config/` | the installation manifest and its schema |
| `src/db/` | the Drizzle schema, the connection, and the committed migrations |
| `src/commands/` | the application command layer and its registry |
| `src/domain/` | `DesiredState`, the attempt log, Targets, capabilities, placement, sources, naming, diagnosis |
| `src/adapters/` | the adapter contracts, Kubernetes delivery, DNS records, and the two stores |
| `src/reconciler/` | two loops — Target health and capabilities, and deploy convergence |
| `src/web/` | the `web` process — the server, the dispatch surface, and the client |
| `src/web/ui/` | shadcn primitives, in this installation's palette |
| `src/web/views/` | the three screens (§18) |
| `build.ts` | `Bun.build` over the client HTML entry → `dist/` |

There is no framework, no bundler beyond Bun, and no test runner beyond
`bun test`. Navigation, form state, and data loading are hand-rolled, which is
the cost the plan accepted for staying Bun-native.

## The UI

Tailwind v4 and shadcn primitives, compiled by `bun-plugin-tailwind` inside the
same graph walk that bundles the client.

**Two entries, because the client is compiled at two different times.**
`src/web/dev.ts` uses Bun's HTML import, so `bun run dev` compiles on demand and
an edit is visible without a build step. `src/web/server.ts` — what the image
runs — serves `dist/` as files and imports no HTML module at all, which is what
keeps Tailwind, the bundler, and TypeScript out of the runtime: the shipped
image installs `drizzle-orm` and `zod` and nothing else. Both build their route
tables the same way, and `src/web/serve.ts` is everything else they share.

That split is the reason the UI's libraries — React, Radix, lucide — are
`devDependencies` rather than dependencies. They are build inputs that end up
inside `dist/`; the server never resolves one. `test/web/routes.test.ts` reads
the server's module graph and fails if that stops being true.

The palette is not a choice made here: `src/web/client/styles.css` carries the
tokens the prototypes settled, bound to shadcn's token names so `bg-card` and
`text-muted-foreground` resolve to them. Light and dark both ship; the toggle
stamps `data-theme` on the root, and its absence means "follow the OS".

Three screens, each implementing rules §18 settled rather than choices made
while building them:

- **Deploy** (`views/apps/deploy-detail.tsx`) — App-first, not attempt-first.
  State and URL, then diagnosis, then a dense resource list, then the log. No
  stage rail. `blame` gets a chip, the build log opens only when the *build* is
  what failed, and **the red screen says the previous release is still serving**.
- **Workspace** (`views/apps/workspace.tsx`) — live state and URL lead; Target
  and the immutable vessel are visible; Components and Datastores are peer
  sections. A website states that it has no runtime instead of showing an empty
  log.
- **Create** (`views/apps/new/`) — Source → Component → Place → Configure →
  Review, defaults carrying every step, preflight folded into Review. An unmet
  prerequisite stops before any Build exists, keeps the draft, and names what
  clears it.

The browser reaches the server through **one dispatch surface generated from the
command registry** (`src/web/dispatch.ts`): one route per command, built by
`Object.fromEntries` over `commandNames`, so there is nowhere to write a route
that is not a command. It is unversioned, marked internal, and
session-authenticated only — never a token, because a token is what turns an
internal protocol into an API §21 declined to declare.

## The command layer

Every user act is a command taking an explicit input and a request context, and
the registry maps name → `{ input schema, handler }`. **A route may never hold
domain logic**: `dispatch()` validates through the registry before a handler
runs, so the browser endpoint is a mechanical wrap of the registry rather than a
place decisions can accumulate. A command exported but not registered is a
compile error, and so is a registry key that is not a command.

## Targets, capabilities, and placement

A `Target` is flat and has exactly one adapter type, so connecting a cloud
project registers two of them — `cloudrun` and `static`. **Connect always
succeeds**: an unreachable cluster still produces a Target, unhealthy, with every
unmet prerequisite and the sentence behind it. **Disconnect strands rather than
stops**: live Deploys go orphaned, nothing is destroyed, the confirmation names
what it left running, and reconnecting re-adopts whatever `observe` still finds.

One loop (`src/reconciler/target-loop.ts`) refreshes health and capabilities
together, because a connect-time snapshot rots. It stores what was observed and
never what was concluded — `verifiedDeploy` (which requires an *enforcing* policy
engine, not an installed one) and `offlineDeploy` (a static check over the chart,
image, and verifier references) are derived at read time.

Placement is a filter, not a scheduler. Derived requirements — nothing is
authored by a developer — narrow connected Targets to candidates, the
highest-ranked one is suggested, and **non-candidates are returned listed and
annotated with why**, so "nowhere fits" is an answer rather than a deploy that
fails later.

## Build, Deploy, and the loop

A **Build** records an artifact; it never deploys one. Uploading an archive of
finished output produces a `SUCCEEDED` Build with the bundle digest naming the
artifact and **no build route consulted at all** — there is nothing to run, and
running one would produce a second digest over the same bytes. Everything else
goes through a route, and the route's name and log fidelity land on the Build so
a thin log reads as the runner it is rather than as a bug.

A **Deploy** is an intent, written under `SELECT ... FOR UPDATE` on the one
`(Component, Target)` desired row. That locking read is the whole of the
concurrency design: two intents for one pair serialize, and the second reads what
the first committed rather than what preceded both. **Rollback is an ordinary
deploy** — a newer intent naming an older Build — and it asks only one extra
question, under the same lock, so it cannot become a way to place what a forward
deploy refused.

`src/reconciler/deploy-loop.ts` is what turns an intent into a workload. It
**claims with `FOR UPDATE SKIP LOCKED` and then lets the lock go**, because the
claim is the `APPLYING` phase rather than a held transaction — a lock does not
survive a reconciler restart and a phase does. Phases after that come from the
adapter and never from core's own idea of readiness, and on red the verdict's
reason, detail, and raw payload are written to the Deploy row, because cluster
events expire in about an hour and core's copy is the one that will still exist
tomorrow. **Exposure is never touched by a failure** — the previous release is
still serving. Drift is reported and never corrected: the re-converge is an
ordinary Deploy a person presses.

**The interval is adaptive and the poll is the correctness path.** Seconds while
an attempt is in flight, minutes once converged — which is also the drift
cadence, since drift is information rather than an alarm. `LISTEN/NOTIFY` can
shorten a sleep and can never be required to: a notification is lost when no
listener is connected, so every test here runs with no wake-up wired.

## Naming and DNS

Two layers (§9), with different rules for a reason. **Canonical names nest**
(`web.shop.<apex>`) because they are unproxied; **vanity names are one flat
label** because a single apex's free certificate covers one subdomain level, and
that is where §9's ceiling of roughly twenty of them comes from. Core mints a
canonical name only for a cluster — Cloud Run and static hosting name their own
workloads, and there the adapter reports the address back across the deploy seam.

**Spindrift publishes no record itself, and holds no zone credential.** On a
cluster the names travel on the `HTTPRoute` the App chart renders — the
installation's external-dns runs with `gateway-httproute` among its sources, so
a route carrying a hostname *is* the record, and it is garbage collected with
the release that owns it.

`src/adapters/dns/cr.ts` builds `DNSEndpoint` objects for the names that have no
route to hang on — the live-from-creation status name, and the vanity leg on a
non-metal Target. **Neither of those is built, so nothing calls it yet**; it is
here because external-dns's `crd` source is configured for exactly that gap.
`test/extraction/no-dns-credential.test.ts` is the grep that keeps "no zone
credential" true, and it also asserts DNS is still being described somewhere, so
the negative claim cannot be satisfied by there being no DNS at all.

One name is contended and one is not. The canonical is per Component, so it
never collides. The **vanity name is per App**, so an App with two
network-serving Components has one name and two claimants — it goes to a sole
serving Component and otherwise to none, because putting one hostname on two
routes lets the platform pick a winner arbitrarily. Which Component is the front
door is the developer's to say, and there is nowhere to say it yet.

## Testing

Tests run against a real Postgres — the concurrency design is a claim about
transactions, and a fake cannot falsify it.

**On WSL, `wslc.exe` containers are not reachable from this distro.** They run in
their own WSL VM, so `--publish` binds a port in *that* VM's namespace: the
container is healthy (`wslc.exe exec <name> pg_isready -U postgres` succeeds) and
nothing in this distro can connect to it. The symptom is every database test
failing on a `beforeEach` hook timeout, which reads like a code bug and is not
one. Run Postgres natively instead:

```bash
## WSL — native, because a published container port does not reach this distro
nix shell nixpkgs#postgresql_16 -c bash -c '
  initdb -D /tmp/spg-data -U postgres --auth=trust &&
  pg_ctl -D /tmp/spg-data -l /tmp/spg-data/log \
    -o "-p 15432 -c listen_addresses=127.0.0.1 -c fsync=off" start &&
  createdb -h 127.0.0.1 -p 15432 -U postgres spindrift'

DATABASE_URL=postgres://postgres@127.0.0.1:15432/spindrift bun test
```

On macOS, and anywhere a container's published port is genuinely reachable, a
container is fine:

```bash
docker run --detach --name spindrift-postgres \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=spindrift \
  --publish 127.0.0.1:5432:5432 \
  postgres:18-alpine
```

and `DATABASE_URL` points at it:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/spindrift bun test
```

`test/harness/db.ts` gives every test its own migrated Postgres schema, so tests
never see each other's rows. Adapters are faked only at the contract —
**fake the far side, never our side** — and `test/conformance/adapter-suite.ts`
is one suite every adapter implementation must pass. Adding an adapter without
enrolling it in that suite fails a test that names it.

## The installation manifest

Every value that names a particular installation lives in one document —
`src/config/manifest.schema.ts` defines it, `test/fixtures/installation.example.yaml`
is a complete one for an installation that does not exist. A literal outside
that document is a bug, and `test/extraction/no-literals.test.ts` is what
notices.

It has two scanners with different reach. The **literal** scanner — the half
with teeth, which knows the words that name this installation — reads every file
under `src/`. The **project-id shape** scanner skips `src/web/`: web platform
vocabulary is lowercase hyphenated words, and so is a project id, so over a
browser bundle it reports dozens of findings and no bugs. The test says so at
length, and the exemption is itself tested.

Point the process at one:

```bash
export SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml
# or, inline:
export SPINDRIFT_MANIFEST="$(cat test/fixtures/installation.example.yaml)"
```

Boot fails loudly, naming every offending key, if it is missing or incomplete.
Nothing has a default, because a default here would name someone's homelab.

## Usage

```bash
bun install                             # once, at repo root (workspace member)
bun run --cwd apps/spindrift build      # client → dist/
bun run --cwd apps/spindrift test       # bun test
bun run --cwd apps/spindrift typecheck  # tsc --noEmit

# The UI, compiled on demand — no build step, hot reload.
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift dev      # http://localhost:3000

# What the image runs: serves dist/, so `build` has to have happened.
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift start
```

`mise run ts:check` typechecks and lints the whole workspace, this package
included.
