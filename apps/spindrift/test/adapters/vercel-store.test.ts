/**
 * What the Vercel store promises beyond the shared contract, which
 * `test/conformance/adapters.test.ts` covers.
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

    // The platform serves `plain` and decrypts `encrypted` on request. Only
    // `sensitive` is never returned by its own API.
    expect(api.environment(PROJECT)).toEqual([
      { key: 'DATABASE_URL', type: 'sensitive' },
    ]);
  });

  test('the plaintext never comes back through any verb the contract has', async () => {
    const { store } = storeFor();
    const reference = await store.put(SCOPE, 'TOKEN', 'the-value');

    // This store has no `open`, so every verb it offers returns metadata only.
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

    // Config can be set before the first deploy. The deploy adapter creates the
    // same project, and both name it with `vercelProjectName`.
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

    // The platform answers `403` to a create whose key already exists.
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

    // `describe` gets only the reference, so the reference carries the project.
    expect(reference.key).toBe(`${PROJECT}/TOKEN`);
    expect((await store.describe(reference))?.key).toBe('TOKEN');
  });
});
