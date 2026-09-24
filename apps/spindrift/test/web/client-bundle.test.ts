// Keeps the command registry, the stream transport and the database schema out
// of the client bundle. `build.ts` runs as a subprocess because a `Bun.build`
// nested in `bun test` fails to resolve this app's `../` imports.
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

    // `Bun.build` leaves unknown globals intact, so a `Bun.*` call compiles and
    // then throws `Bun is not defined` in a browser.
    expect(text).not.toMatch(/\bBun\./);
  });

  test('carries no fingerprint of the command layer it used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // Unminified Bun output puts a `// path/to/module.ts` comment ahead of each
    // bundled module, so a missing path means a missing module.
    expect(text).not.toContain('commands/registry.ts');
    // A command handler with server-only imports, checked by name too.
    expect(text).not.toContain('config/manifest-store.ts');
  });

  test('carries no fingerprint of the streaming transport it used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    expect(text).not.toContain('web/streams.ts');
    expect(text).not.toContain('db/notify.ts');
  });

  test('carries no fingerprint of the database layer the auth client used to pull in', async () => {
    const files = await readdir(DIST);
    const entry = files.find((file) => file.endsWith('.js'));
    expect(entry).toBeDefined();
    const text = await Bun.file(join(DIST, entry!)).text();

    // `db/schema.ts` declares every table, so any edge into it pulls in all of `drizzle-orm`.
    expect(text).not.toContain('db/schema.ts');
    expect(text).not.toContain('drizzle-orm');
  });

  test('stays within the ceiling cutting that edge bought back', async () => {
    const files = await readdir(DIST);
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(join(DIST, file))).size),
    );
    const bytes = sizes.reduce((total, size) => total + size, 0);

    expect(built.stdout).toContain(`${files.length} files`);

    // Counts source maps. About 1 MiB over the current build and well under the
    // size with the command registry back in: ~3 MiB more JS, doubled by its map.
    const CEILING_BYTES = 7.5 * 1024 * 1024;
    expect(bytes).toBeLessThan(CEILING_BYTES);
  });
});
