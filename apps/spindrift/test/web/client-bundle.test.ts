/**
 * The client bundle's three edges into the server — command dispatch,
 * streaming, and auth — and the ceiling that keeps any of them from growing
 * back.
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
 * The fix (PR #1496) moved `pathFor`, `COMMAND_PATH_PREFIX`, and
 * `TransportFailureCode` into `src/web/command-path.ts`, which takes
 * `CommandName` as `import type` only — erased at compile time, so Bun never
 * turns it into a module edge. `dispatch.ts` re-exports the three from there
 * rather than defining them itself, so the server side is unchanged.
 *
 * `.agent/plans/spindrift/issues/34-keep-the-server-out-of-the-browser-bundle.md`
 * names the same shape a second time, independently: `app.tsx` value-imported
 * `subscribeAttempt`/`subscribeRuntime` from `stream-client.ts`, which
 * value-imported the stream paths and message types from `streams.ts` —
 * the WebSocket transport that value-imports `drizzle-orm`, `db/notify.ts`,
 * and `db/schema.ts` to serve them. The fix is the same move: the two stream
 * paths and the message types now live in `src/web/stream-path.ts`, which
 * takes `AttemptLogCursor`/`AttemptLogEntry` (from `domain/attempt-log.ts`)
 * and `RuntimeLogPage` (from `adapters/deploy/contract.ts`) as `import type`
 * only. `streams.ts` re-exports from there rather than defining them itself.
 *
 * The same ticket's edge 3, found while verifying edge 2: cutting the
 * streaming edge left the bundle's `drizzle-orm` count unchanged, because
 * `app.tsx` value-imported `auth-client.ts`, which value-imported
 * `AUTH_PATH_PREFIX` and `AuthAct` from `src/auth/routes.ts` — and
 * `routes.ts` value-imports `session.ts`, which value-imports `credentials`,
 * `sessions`, and `users` from `db/schema.ts`. `db/schema.ts` is one module
 * declaring every table, so that one edge dragged the whole file, and with it
 * the whole `drizzle-orm` surface, regardless of which table the importer
 * wanted. The fix is the same move a third time: `AUTH_PATH_PREFIX`,
 * `AUTH_ACTS`, `AuthAct`, and `authPathFor` now live in
 * `src/web/auth-path.ts`, a leaf module with no imports of its own, and
 * `routes.ts` re-exports from there rather than defining them itself.
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
  test('does not depend on the Bun runtime in a browser', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // `Bun.build` leaves unknown globals intact. A `Bun.*` call can therefore
    // compile and pass Bun-hosted unit tests, then throw `Bun is not defined`
    // when a browser reaches it. The client must use browser APIs only.
    expect(text).not.toMatch(/\bBun\./);
  });

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

  test('carries no fingerprint of the streaming transport it used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // Ticket 34, edge 2: `stream-client.ts` used to value-import the two
    // stream paths and the message types directly from `streams.ts`, which
    // drags in the WebSocket transport — `upgradeAttempt`, `upgradeRuntime`,
    // `readStreamPage` — and, through it, `db/notify.ts`'s `onAttemptEvent`.
    // Neither module name should appear in the built bundle if the edge into
    // `stream-path.ts` (`import type` only past the two message-shape
    // dependencies) is holding.
    expect(text).not.toContain('web/streams.ts');
    expect(text).not.toContain('db/notify.ts');
  });

  test('carries no fingerprint of the database layer the auth client used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // Ticket 34, edge 3: `auth-client.ts` used to value-import
    // `AUTH_PATH_PREFIX` and `AuthAct` directly from `src/auth/routes.ts`,
    // which value-imports `session.ts`, which value-imports `credentials`,
    // `sessions`, and `users` from `db/schema.ts` — one module declaring
    // every table, so that edge dragged the whole file, and with it the
    // whole `drizzle-orm` surface, into the bundle. This is the edge item 2
    // of the ticket's checklist found unmoved: cutting the streaming edge
    // left `grep -c "drizzle-orm" dist/chunk-*.js` at 57, because this edge
    // was still open. Asserting on the literal string rather than a count is
    // the stronger claim and the one the ticket asks for: zero occurrences,
    // not merely fewer.
    expect(text).not.toContain('db/schema.ts');
    expect(text).not.toContain('drizzle-orm');
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

    // Measured today: ~6.5 MiB for this exact build — ordinary UI growth on
    // top of the ~5.4 MiB measured when the registry edge was cut. Before that
    // cut, with the whole command layer pulled in through `client.ts` ->
    // `dispatch.ts` -> `registry.ts`, the same build was ~8.7 MiB (the number
    // `2026-08-01`'s ticket comment records).
    //
    // **This sums every file in `dist/`, source maps included**, and the map is
    // where the growth is: a screen gaining a hundred lines costs ~3 KiB of
    // JavaScript and ~25 KiB of map, because the map embeds this codebase's
    // source text and this codebase explains itself at length. So the headroom
    // a ceiling here buys is about eight times smaller than the shipped bytes
    // suggest, and a ceiling set close above a measurement is one screen from
    // tripping on a change that added nothing a browser downloads.
    //
    // The ceiling below sits at 7.5 MiB: a MiB above today's measured size, and
    // still two below what reintroducing the registry edge would cost (+~3 MiB
    // of JavaScript, which the map doubles again), so that regression trips
    // this rather than shipping unnoticed the way it did the first time.
    const CEILING_BYTES = 7.5 * 1024 * 1024;
    expect(bytes).toBeLessThan(CEILING_BYTES);
  });
});
