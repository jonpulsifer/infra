/**
 * What the edge-platform store promises beyond the shared contract.
 *
 * `test/conformance/adapters.test.ts` already runs this adapter through every
 * term of §10 that all stores share. Two claims are this platform's own and
 * would pass that suite while being false, so they are asserted here:
 *
 * - **The value is written as the one type the platform will not hand back.**
 *   §10's "values are write-only" is a claim about Spindrift, and it is worth
 *   nothing if the store Spindrift wrote to serves the value to anyone holding
 *   the same token. A `plain` or `encrypted` variable does exactly that.
 * - **The project exists before config is written to it.** Config is routinely
 *   set the moment a Component is placed, which is before any Build has
 *   finished — so the deploy adapter has not created anything yet, and a store
 *   that assumed otherwise would fail every first `setConfig`.
 */
import { describe, expect, test } from 'bun:test';
import { VercelSecretStore } from '../../src/adapters/store/vercel.ts';
import { vercelProjectName } from '../../src/domain/vercel-project.ts';
import { FakeVercel } from '../harness/fakes/vercel-api.ts';

const SCOPE = { app: 'shop', component: 'web', target: 'edge_vercel' };
const PROJECT = vercelProjectName(SCOPE);

function storeFor(options: { projects?: readonly string[] } = {}) {
  const api = new FakeVercel({ projects: options.projects ?? [] });
  const store = new VercelSecretStore({
    baseUrl: api.endpoint,
    token: api.token,
    team: api.team,
    fetch: api.fetch,
  });
  return { api, store };
}

describe('§10: the value is write-only on the far side too', () => {
  test('config is written as a sensitive variable, never a readable one', async () => {
    const { api, store } = storeFor();
    await store.put(SCOPE, 'DATABASE_URL', 'postgres://secret');

    // The platform decrypts `encrypted` on request and serves `plain` outright.
    // Only `sensitive` is refused to its own API, which is what makes a leaked
    // platform token read no config.
    expect(api.environment(PROJECT)).toEqual([
      { key: 'DATABASE_URL', type: 'sensitive' },
    ]);
  });

  test('the plaintext never comes back through any verb the contract has', async () => {
    const { store } = storeFor();
    const reference = await store.put(SCOPE, 'TOKEN', 'the-value');

    // Not a call that fails — a call that does not exist. Everything the
    // contract offers is asserted to carry metadata and nothing else.
    const described = await store.describe(reference);
    const listed = await store.versions(SCOPE, 'TOKEN');
    expect(JSON.stringify([described, listed])).not.toContain('the-value');
  });
});

describe('config can be set before anything has been deployed', () => {
  test('the project is created when it is not there yet', async () => {
    const { api, store } = storeFor({ projects: [] });
    expect(api.hasProject(PROJECT)).toBe(false);

    await store.put(SCOPE, 'TOKEN', 'value');

    // The deploy adapter creates the same project as a side effect of its
    // first deployment; whichever runs first wins, and both name it the same
    // way because both go through `vercelProjectName`.
    expect(api.hasProject(PROJECT)).toBe(true);
  });

  test('an existing project is used rather than recreated', async () => {
    const { api, store } = storeFor({ projects: [PROJECT] });
    await store.put(SCOPE, 'TOKEN', 'value');

    expect(api.pathsOf('POST')).not.toContain('/v9/projects');
    expect(api.environment(PROJECT)).toHaveLength(1);
  });
});

describe('a put supersedes rather than accumulating', () => {
  test('the old variable is removed before the new one is created', async () => {
    const { api, store } = storeFor();
    const first = await store.put(SCOPE, 'TOKEN', 'one');
    const second = await store.put(SCOPE, 'TOKEN', 'two');

    // The platform answers `403` to a create whose key already exists, so the
    // delete is not tidiness — it is the only thing that makes the second put
    // work at all. One variable survives, under a new reference.
    expect(second).not.toEqual(first);
    expect(api.environment(PROJECT)).toEqual([
      { key: 'TOKEN', type: 'sensitive' },
    ]);
    expect(await store.describe(first)).toBeNull();
  });
});

describe('a reference names the project it lives on', () => {
  test('describe works from the reference alone, with no scope', async () => {
    const { store } = storeFor();
    const reference = await store.put(SCOPE, 'TOKEN', 'value');

    // `describe` is handed a reference and nothing else, so the project has to
    // be in it — a variable name alone does not say which of an installation's
    // projects to look on.
    expect(reference.key).toBe(`${PROJECT}/TOKEN`);
    expect((await store.describe(reference))?.key).toBe('TOKEN');
  });
});
