# spindrift

Connect a repo, press Deploy, get a URL.

Spindrift is a deploy layer, not a platform: it owns the UI and the feel, and
adapts to whatever builds and delivers underneath — a Kubernetes cluster, Cloud
Run, or static hosting. The design lives in `.agent/plans/spindrift/spec.md`
(private) and is referenced from the source as `§N`.

**This is a scaffold.** What exists is the workspace package, the installation
manifest, the extraction test that polices it, and a placeholder screen. No App,
Component, Build, Deploy, or Datastore yet.

## Shape

One image, two processes (§19):

| Path | What it is |
| --- | --- |
| `src/web/` | the `web` process — UI, webhooks, log WebSockets |
| `src/config/` | the installation manifest and its schema |
| `build.ts` | `Bun.build` over the client HTML entry → `dist/` |

There is no framework, no bundler beyond Bun, and no test runner beyond
`bun test`.

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
