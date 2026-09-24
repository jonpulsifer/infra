# @repo/kthx

The static files a [kthx](https://wiki.lolwtf.ca/apps/kthx/sites/) host serves: the landing page on the zone apex, the browser SDK (`window.kthx`), the agent reference, and the default favicon.

The `apps/kthx` server reads `landing.html`, `sdk.js` and `skill.md` from disk at run time through `assets.ts`. `kthx init` writes `skill.md` into a new site as `SKILL.md`. The subpath exports in `package.json` are the public modules.

## Develop

```bash
bun run --cwd packages/kthx typecheck
bun run --cwd packages/kthx lint
```

The package has no tests of its own. The tests in `apps/kthx/test/server/` cover how the server serves these files.

## Deploy

The package has no manifests of its own. The `apps/kthx` image copies it in, and the CLI bundle from `apps/kthx/pack.ts` inlines the agent reference and the favicon.
