# spindrift

Connect a repo, press Deploy, get a URL.

Spindrift is a deploy layer, not a platform: it owns the UI and the feel, and
adapts to whatever builds and delivers underneath — a Kubernetes cluster, Cloud
Run, or static hosting. The design lives in `.agent/plans/spindrift/spec.md`
(private) and is referenced from the source as `§N`.

**The foundations exist; nothing deploys yet.** The five nouns have tables, the
three adapter contracts are written, and commands are the only way anything is
acted on. What has no implementation is every adapter — no real cluster, cloud
runtime, static host, build route, or secret store is spoken to. The UI is a
placeholder.

## Shape

One image, two processes (§19); only `web` exists so far.

| Path | What it is |
| --- | --- |
| `src/config/` | the installation manifest and its schema |
| `src/db/` | the Drizzle schema, the connection, and the committed migrations |
| `src/commands/` | the application command layer and its registry |
| `src/domain/` | `DesiredState` and the attempt event log |
| `src/adapters/` | the deploy, build, and store contracts |
| `src/web/` | the `web` process — UI, webhooks, log WebSockets |
| `build.ts` | `Bun.build` over the client HTML entry → `dist/` |

There is no framework, no bundler beyond Bun, and no test runner beyond
`bun test`.

## The command layer

Every user act is a command taking an explicit input and a request context, and
the registry maps name → `{ input schema, handler }`. **A route may never hold
domain logic**: `dispatch()` validates through the registry before a handler
runs, so the browser endpoint is a mechanical wrap of the registry rather than a
place decisions can accumulate. A command exported but not registered is a
compile error, and so is a registry key that is not a command.

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
bun install                       # once, at repo root (workspace member)
bun run --cwd apps/spindrift build      # client → dist/
bun run --cwd apps/spindrift test       # bun test
bun run --cwd apps/spindrift typecheck  # tsc --noEmit
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift dev      # http://localhost:3000
```

`mise run ts:check` typechecks and lints the whole workspace, this package
included.
