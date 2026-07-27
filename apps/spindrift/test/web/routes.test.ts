/**
 * The served route table — the file a hand-authored route would actually
 * appear in.
 *
 * `dispatch.test.ts` asserts over `commandRoutes`, which is generated and so
 * cannot fail the assertion; that test proves the generator is right, not that
 * the server is. The plan's warning is about somewhere else entirely — "watch
 * for the first hand-authored route; that is the drift" — and the place to
 * write one is the table that spreads the generated set alongside the document
 * and the health probe.
 *
 * So this file reads that table. Adding a route to `routes.ts` without adding
 * it to {@link NON_COMMAND_ROUTES}, which is a list somebody has to edit on
 * purpose, fails here.
 */
import { describe, expect, test } from 'bun:test';
import { commandNames } from '../../src/commands/registry.ts';
import { pathFor } from '../../src/web/dispatch.ts';
import { NON_COMMAND_ROUTES, webRoutes } from '../../src/web/routes.ts';

/** The document is a bundler artifact in production; its identity is irrelevant. */
const INDEX = { html: true };

const served = webRoutes(INDEX, {
  session: async () => null,
  context: () => {
    throw new Error('unreachable in a route-table test');
  },
});

describe('what the web process serves', () => {
  test('is command routes plus the two exceptions, and nothing else', () => {
    expect(Object.keys(served).sort()).toEqual(
      [...Object.keys(NON_COMMAND_ROUTES), ...commandNames.map(pathFor)].sort(),
    );
  });

  test('every route that is not a command is one somebody listed', () => {
    const commandPaths = new Set<string>(commandNames.map(pathFor));
    const unlisted = Object.keys(served).filter(
      (path) => !commandPaths.has(path) && !(path in NON_COMMAND_ROUTES),
    );
    expect(unlisted).toEqual([]);
  });

  test('and the exceptions are only the document and the probe', () => {
    // Deliberately restated as a literal rather than derived. This is the list
    // whose *growth* is the thing being watched, so the test has to disagree
    // when it grows — a derivation would grow with it silently.
    expect(Object.keys(NON_COMMAND_ROUTES).sort()).toEqual(['/', '/healthz']);
  });

  test('the health probe reaches nothing', async () => {
    // §21: no route may hold domain logic. The probe is a constant, which is
    // the strongest form of that — it cannot consult anything.
    const probe = served['/healthz'];
    expect(probe).toBeInstanceOf(Response);
    expect(await (probe as Response).clone().text()).toBe('ok\n');
  });

  test('the document is served at the root and nowhere else', () => {
    // The client owns navigation (a hash router), so there is no per-screen
    // route and no catch-all. A second HTML route would mean the server had
    // started routing screens.
    expect(served['/']).toBe(INDEX);
    expect(
      Object.entries(served).filter(([, handler]) => handler === INDEX),
    ).toHaveLength(1);
  });
});
