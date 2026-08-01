/**
 * The client bundle's only edge into the command layer, and the ceiling that
 * keeps it from growing back.
 *
 * `.agent/plans/spindrift/issues/32-onboard-an-installation-without-a-manifest.md`
 * (2026-08-01 comment) names the landmine: `client.ts` value-imported
 * `pathFor` from `dispatch.ts`, and `dispatch.ts` value-imported `dispatch`
 * and `commandNames` from `commands/registry.ts` — the registry that wires
 * every command handler to its drizzle queries and adapters. Bun resolves
 * imports before tree-shaking, so an export nothing calls is still a build
 * error, and PR #1492's CI proved it: a change nowhere near the browser broke
 * the client build, because `configureInstallation` importing
 * `config/manifest-store.ts` was the first command handler to reach for a
 * server-only Node polyfill the browser build does not carry.
 *
 * The fix moved `pathFor`, `COMMAND_PATH_PREFIX`, and `TransportFailureCode`
 * into `src/web/command-path.ts`, which takes `CommandName` as `import type`
 * only — erased at compile time, so Bun never turns it into a module edge.
 * `dispatch.ts` re-exports the three from there rather than defining them
 * itself, so the server side is unchanged.
 *
 * This runs `build.ts` itself, as a real subprocess — the same command the
 * Dockerfile's `builder` stage runs (`bun run build --filter=spindrift`,
 * which resolves to `bun run build.ts` in this package) — rather than calling
 * `Bun.build` in-process. A nested `Bun.build` invoked from inside the
 * `bun test` runtime fails to resolve this app's own `../`-relative imports
 * (a `bun test`-specific resolver quirk, reproduced against a minimal
 * fixture independently of this change); shelling out sidesteps it and is
 * more honest besides, since it is the literal command CI and the image run.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const APP = join(import.meta.dir, '../..');

async function buildClient(): Promise<{ readonly stdout: string }> {
  const proc = Bun.spawn(['bun', 'run', 'build.ts'], {
    cwd: APP,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`bun run build.ts exited ${exitCode}\n${stderr}`);
  }
  return { stdout };
}

const built = await buildClient();
const DIST = join(APP, 'dist');

describe('the client bundle', () => {
  test('carries no fingerprint of the command layer it used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // Bun's unminified output keeps a `// path/to/module.ts` comment ahead of
    // each bundled module — the same shape PR #1492's CI failure named a file
    // by (`src/config/manifest-store.ts:8:10`). If `commands/registry.ts`
    // does not appear here, none of the handlers it wires are in the bundle
    // either, which is the property this whole fix rests on.
    expect(text).not.toContain('commands/registry.ts');
    // The handler whose server-only import broke #1492's build, named
    // directly rather than only through the registry it is reached from.
    expect(text).not.toContain('config/manifest-store.ts');
  });

  test('stays within the ceiling cutting that edge bought back', async () => {
    const files = await readdir(DIST);
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(join(DIST, file))).size),
    );
    const bytes = sizes.reduce((total, size) => total + size, 0);

    // `build.ts` prints its own total; keeping this test's math and its
    // console line honest against each other.
    expect(built.stdout).toContain(`${files.length} files`);

    // Measured on this branch: ~5.4 MiB for this exact build, once the
    // registry stopped being reachable. Before the fix, with the whole
    // command layer pulled in through `client.ts` -> `dispatch.ts` ->
    // `registry.ts`, the same build was ~8.7 MiB (the number
    // `2026-08-01`'s ticket comment records). The ceiling below sits at
    // 6 MiB: comfortably above today's measured size — headroom for
    // ordinary UI growth — and comfortably below what reintroducing the
    // registry edge would cost (+~3 MiB), so that regression trips this
    // rather than shipping unnoticed the way it did the first time.
    const CEILING_BYTES = 6 * 1024 * 1024;
    expect(bytes).toBeLessThan(CEILING_BYTES);
  });
});
