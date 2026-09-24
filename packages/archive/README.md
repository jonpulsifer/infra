# @repo/archive

Archive code shared by the two halves of [kthx](../../docs/apps/kthx.md). It converts uploads to gzipped tar, reads files out of a bundle, reads and writes GCS objects through workload identity federation with no stored key, and encodes base64url.

`apps/kthx` stages site releases with it and `apps/spindrift` stages built-app sources, so both apps use one archive format. Code that reads a kthx manifest or database stays in the app that owns it. The subpath exports in `package.json` are the public modules.

## Develop

```bash
bun run --cwd packages/archive test
bun run --cwd packages/archive typecheck
bun run --cwd packages/archive lint
```

## Deploy

The package has no manifests of its own. The `apps/kthx` and `apps/spindrift` images copy it in and import it at run time.
