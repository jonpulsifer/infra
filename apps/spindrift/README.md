# spindrift

Connect a repo, press Deploy, get a URL.

Spindrift is a deploy layer, not a platform: it owns the UI and the feel, and
adapts to whatever builds and delivers underneath — a Kubernetes cluster, Cloud
Run, or static hosting. The design lives in `.agent/plans/spindrift/spec.md`
(private) and is referenced from the source as `§N`.

**Targets are real, the screens are drawn, nothing deploys yet.** The five nouns
have tables, the three adapter contracts are written, and commands are the only
way anything is acted on. Targets can be connected, inspected on a loop, and
resolved against — asking where a Component can go returns an answer with a
reason for every Target it cannot. The two secret stores are implemented.

What has no implementation is every *deploy* adapter — no real cluster, cloud
runtime, static host, or build route is spoken to — so a Deploy row is still
something nothing writes. **The three screens therefore render placeholder
data** from `src/web/demo/`, which is scaffolding meant to be deleted: the views
are typed against `src/web/model.ts`, so the query commands that replace it have
a contract to meet rather than a shape to guess.

Two named gaps behind the screens, both deliberate:

- **Nobody can sign in.** Passkey enrolment and sessions are unbuilt, so every
  command route answers 401. The boundary is complete and rejects everything,
  rather than carrying a development bypass that would become permanent.
- **The creation draft is client state**, so a refresh mid-flow loses it. It
  wants a table and a pair of commands, which belong with the App and Component
  commands rather than in front of them.

## Shape

One image, two processes (§19); only `web` exists so far.

| Path | What it is |
| --- | --- |
| `src/config/` | the installation manifest and its schema |
| `src/db/` | the Drizzle schema, the connection, and the committed migrations |
| `src/commands/` | the application command layer and its registry |
| `src/domain/` | `DesiredState`, the attempt log, Targets, capabilities, placement |
| `src/adapters/` | the deploy, build, and store contracts, plus the two stores |
| `src/reconciler/` | the loop that refreshes Target health and capabilities |
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

## Testing

Tests run against a real Postgres — the concurrency design is a claim about
transactions, and a fake cannot falsify it. `DATABASE_URL` must point at one:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/spindrift bun test
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
