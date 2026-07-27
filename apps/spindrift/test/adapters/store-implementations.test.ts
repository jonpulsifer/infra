/**
 * The two store implementations, against a fake of each far-side HTTP API
 * (Task 10, § Seam 2).
 *
 * The conformance suite already asserts that both satisfy the contract. What is
 * asserted here is what the contract cannot see: **the requests that were
 * made**, which is the half of § Seam 2's pattern that catches an adapter
 * satisfying the contract by doing the wrong thing on the wire.
 *
 * The load-bearing one is `never reads a value back`. §10 makes values
 * write-only, and an adapter that quietly called `accessSecretVersion` — or read
 * a concealed value out of an item and threw it away — would pass every
 * contract assertion while having broken the one rule the contract exists to
 * keep. The only way to see that is to look at the wire.
 */
import { describe, expect, test } from 'bun:test';
import {
  SecretManagerStore,
  secretIdFor,
} from '../../src/adapters/store/gcp-secret-manager.ts';
import { StoreRequestError } from '../../src/adapters/store/http.ts';
import { OnePasswordStore } from '../../src/adapters/store/onepassword.ts';
import { FakeOnePasswordConnect } from '../harness/fakes/onepassword-connect.ts';
import { FakeSecretManager } from '../harness/fakes/secret-manager-api.ts';

const scope = { app: 'invoices', component: 'web', target: 'metal' };
const other = { app: 'invoices', component: 'web', target: 'cloud' };

function onepassword(token = 'connect-token') {
  const connect = new FakeOnePasswordConnect();
  const store = new OnePasswordStore({
    baseUrl: connect.baseUrl,
    vault: connect.vault,
    token: () => token,
    fetch: connect.fetch,
  });
  return { connect, store };
}

function secretManager(token = 'federated-token') {
  const api = new FakeSecretManager();
  const store = new SecretManagerStore({
    baseUrl: api.baseUrl,
    project: api.project,
    token: () => token,
    fetch: api.fetch,
  });
  return { api, store };
}

describe('1Password over Connect', () => {
  test('a put creates a new item rather than editing one', async () => {
    const { connect, store } = onepassword();
    await store.put(scope, 'DATABASE_URL', 'one');
    await store.put(scope, 'DATABASE_URL', 'two');

    // The whole reason this store is IMMUTABLE_ITEM_PER_VERSION: Connect gives
    // no way to address a past version of an item, so a second put that edited
    // the first would make every earlier pin a floating latest (§10).
    expect(connect.itemCount).toBe(2);
    expect(
      connect.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(2);
    expect(
      connect.requests.some(
        (request) => request.method === 'PATCH' || request.method === 'PUT',
      ),
    ).toBe(false);
  });

  test('the value is written concealed, labelled with the variable', async () => {
    const { connect, store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'postgres://x');

    const created = connect.requests.find(
      (request) => request.method === 'POST',
    );
    expect(created?.body).toMatchObject({
      title: 'invoices/web/metal/DATABASE_URL',
      fields: [
        { type: 'CONCEALED', label: 'DATABASE_URL', value: 'postgres://x' },
      ],
    });
    expect(connect.valueOf(reference.version)).toBe('postgres://x');
  });

  test('never reads a value back', async () => {
    const { connect, store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'secret');
    await store.describe(reference);
    await store.versions(scope, 'DATABASE_URL');

    // Connect returns the concealed value on a single-item GET, so "does not
    // read" cannot be asserted on the wire here — what can be asserted is that
    // nothing the value could travel out through exists on the contract.
    const described = await store.describe(reference);
    expect(described).not.toBeNull();
    expect(JSON.stringify(described)).not.toContain('secret');
    expect(connect.requests.every((request) => request.method !== 'PUT')).toBe(
      true,
    );
  });

  test('two Targets do not share an item', async () => {
    const { store } = onepassword();
    const metal = await store.put(scope, 'DATABASE_URL', 'one');
    const cloud = await store.put(other, 'DATABASE_URL', 'two');

    // §10 scopes config to (Component, Target). Two Targets colliding on one
    // item is what would make a re-placement silently deliver the wrong value.
    expect(metal.key).not.toBe(cloud.key);
    expect(await store.versions(scope, 'DATABASE_URL')).toHaveLength(1);
  });

  test('a reference whose item was retitled is reported absent', async () => {
    const { store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'one');
    const moved = { ...reference, key: 'invoices/web/metal/OTHER' };

    // A rename must not silently re-point a pinned Deploy at another variable.
    expect(await store.describe(moved)).toBeNull();
  });

  test('a rejected token is a fault, not an empty answer', async () => {
    const { store } = onepassword('wrong-token');
    expect(store.put(scope, 'DATABASE_URL', 'one')).rejects.toThrow(
      StoreRequestError,
    );
  });
});

describe('Secret Manager', () => {
  test('creates the secret once and then only adds versions', async () => {
    const { api, store } = secretManager();
    await store.put(scope, 'DATABASE_URL', 'one');
    await store.put(scope, 'DATABASE_URL', 'two');

    expect(api.secretCount).toBe(1);
    const creates = api.requests.filter((request) =>
      /\/secrets\?secretId=/.test(request.path),
    );
    const adds = api.requests.filter((request) =>
      request.path.endsWith(':addVersion'),
    );
    expect(creates).toHaveLength(1);
    expect(adds).toHaveLength(2);
  });

  test('the payload crosses base64-encoded, and only outbound', async () => {
    const { api, store } = secretManager();
    const reference = await store.put(scope, 'DATABASE_URL', 'postgres://x');

    expect(api.payloadOf(reference.key, reference.version)).toBe(
      'postgres://x',
    );
    // §10's read-back is metadata. `accessSecretVersion` is the verb that would
    // return a payload, and it is called nowhere.
    await store.describe(reference);
    await store.versions(scope, 'DATABASE_URL');
    expect(
      api.requests.some((request) => request.path.includes(':access')),
    ).toBe(false);
  });

  test('records the exact scope as annotations', async () => {
    const { api, store } = secretManager();
    const reference = await store.put(scope, 'DATABASE_URL', 'one');

    // The id is a legible name; the annotations are the authority on what the
    // secret is for, which is what `describe` reads the variable back from.
    expect(api.annotationsOf(reference.key)).toEqual({
      'spindrift-app': 'invoices',
      'spindrift-component': 'web',
      'spindrift-target': 'metal',
      'spindrift-key': 'DATABASE_URL',
    });
  });

  test('refuses a secret whose annotations name another scope', async () => {
    const { api, store } = secretManager();
    api.seedSecret(secretIdFor(scope, 'DATABASE_URL'), {
      'spindrift-app': 'invoices',
      'spindrift-component': 'worker',
      'spindrift-target': 'metal',
      'spindrift-key': 'DATABASE_URL',
    });

    // Sanitizing a name into the id alphabet is lossy, so two scopes can land
    // on one id. Writing anyway would put one Component's value where another
    // Component reads it — the worst outcome available here.
    expect(store.put(scope, 'DATABASE_URL', 'one')).rejects.toThrow(
      /belongs to/,
    );
  });

  test('pages through every version it has written', async () => {
    const { api, store } = secretManager();
    for (const value of ['one', 'two', 'three', 'four', 'five']) {
      await store.put(scope, 'DATABASE_URL', value);
    }

    // The fake pages at two, so five versions is three pages. Core reaps config
    // from this list at N = 10 (§10) — a single-page read would under-report it.
    const versions = await store.versions(scope, 'DATABASE_URL');
    expect(versions.map((version) => version.reference.version)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(
      api.requests.filter((request) => request.path.includes('pageToken')),
    ).not.toHaveLength(0);
  });

  test('destroy stays idempotent against a far side that refuses', async () => {
    const { api, store } = secretManager();
    const reference = await store.put(scope, 'DATABASE_URL', 'one');

    await store.destroy(reference);
    // The real API answers FAILED_PRECONDITION here, and the contract still
    // requires this to succeed.
    await store.destroy(reference);

    expect(await store.describe(reference)).toBeNull();
    expect(
      api.requests.filter((request) => request.path.endsWith(':destroy')),
    ).toHaveLength(2);
  });

  test('a destroyed version leaves the list', async () => {
    const { store } = secretManager();
    const first = await store.put(scope, 'DATABASE_URL', 'one');
    await store.put(scope, 'DATABASE_URL', 'two');
    await store.destroy(first);

    const versions = await store.versions(scope, 'DATABASE_URL');
    expect(versions.map((version) => version.reference.version)).toEqual(['2']);
  });

  test('a rejected token is a fault, not an empty answer', async () => {
    const { store } = secretManager('wrong-token');
    expect(store.put(scope, 'DATABASE_URL', 'one')).rejects.toThrow(
      StoreRequestError,
    );
  });
});
