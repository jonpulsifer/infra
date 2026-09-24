/**
 * The 1Password and Secret Manager stores against fakes of their HTTP APIs.
 * The conformance suite covers the contract; these assert the requests made.
 */
import { describe, expect, test } from 'bun:test';
import {
  SecretManagerStore,
  secretIdFor,
} from '../../src/adapters/store/gcp-secret-manager.ts';
import { StoreRequestError } from '../../src/adapters/store/http.ts';
import {
  OnePasswordStore,
  SPINDRIFT_SECTION,
} from '../../src/adapters/store/onepassword.ts';
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

    // Connect cannot address a past version of an item, so editing one would
    // turn every earlier pin into a floating latest.
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
      // Connect refuses a create without a vault or a category.
      vault: { id: connect.vault },
      category: 'API_CREDENTIAL',
      title: 'invoices/web/metal/DATABASE_URL',
      sections: [{ id: SPINDRIFT_SECTION }],
      fields: [
        {
          type: 'CONCEALED',
          label: 'DATABASE_URL',
          value: 'postgres://x',
          section: { id: SPINDRIFT_SECTION },
        },
      ],
    });
    expect(connect.valueOf(reference.version)).toBe('postgres://x');
  });

  test('reads back the variable it wrote, not a category default', async () => {
    const { connect, store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'postgres://x');

    // Connect puts an API_CREDENTIAL's own labelled fields (username,
    // credential, notesPlain) ahead of the caller's field.
    const item = (await connect
      .fetch(
        new Request(
          `${connect.baseUrl}/v1/vaults/${connect.vault}/items/${reference.version}`,
          { headers: { Authorization: 'Bearer connect-token' } },
        ),
      )
      .then((response) => response.json())) as {
      fields: { label?: string; type?: string }[];
    };
    expect(item.fields[0]?.label).not.toBe('DATABASE_URL');
    expect(item.fields.map((field) => field.label)).toContain('credential');

    const described = await store.describe(reference);
    expect(described?.key).toBe('DATABASE_URL');
  });

  test('an item without a Spindrift field is not one this store wrote', async () => {
    const { connect, store } = onepassword();
    const created = (await connect
      .fetch(
        new Request(`${connect.baseUrl}/v1/vaults/${connect.vault}/items`, {
          method: 'POST',
          headers: { Authorization: 'Bearer connect-token' },
          body: JSON.stringify({
            vault: { id: connect.vault },
            title: 'invoices/web/metal/DATABASE_URL',
            category: 'LOGIN',
            fields: [],
          }),
        }),
      )
      .then((response) => response.json())) as { id: string };

    // The title matches, but the variable is never guessed from a title.
    expect(
      await store.describe({
        key: 'invoices/web/metal/DATABASE_URL',
        version: created.id,
      }),
    ).toBeNull();
  });

  test('never reads a value back', async () => {
    const { connect, store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'secret');
    await store.describe(reference);
    await store.versions(scope, 'DATABASE_URL');

    // Connect returns the concealed value on a single-item GET, so this checks
    // what `describe` returns, not the wire.
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

    // Config is scoped to (Component, Target); a shared item would deliver the
    // wrong value after a re-placement.
    expect(metal.key).not.toBe(cloud.key);
    expect(await store.versions(scope, 'DATABASE_URL')).toHaveLength(1);
  });

  test('a reference whose item was retitled is reported absent', async () => {
    const { store } = onepassword();
    const reference = await store.put(scope, 'DATABASE_URL', 'one');
    const moved = { ...reference, key: 'invoices/web/metal/OTHER' };

    // A rename must not re-point a pinned Deploy at another variable.
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
    // `describe` and `versions` read metadata; only `open` calls `:access`.
    await store.describe(reference);
    await store.versions(scope, 'DATABASE_URL');
    expect(
      api.requests.some((request) => request.path.includes(':access')),
    ).toBe(false);
  });

  test('the create carries a replication policy', async () => {
    const { api, store } = secretManager();
    await store.put(scope, 'DATABASE_URL', 'one');

    // The API refuses a create with no replication policy.
    const created = api.requests.find((request) =>
      /\/secrets\?secretId=/.test(request.path),
    );
    expect(created?.body).toMatchObject({ replication: { automatic: {} } });
  });

  test('a scope past the id ceiling still names a secret the API accepts', async () => {
    const { api, store } = secretManager();
    const long = {
      app: 'a'.repeat(63),
      component: 'c'.repeat(63),
      target: 't'.repeat(63),
    };
    const key = `K${'E'.repeat(120)}Y`;

    // Three 63-character labels and a long key pass the 255-character id limit,
    // and the API refuses an id that long instead of truncating it.
    const id = secretIdFor(long, key);
    expect(id.length).toBeLessThanOrEqual(255);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,255}$/);

    const reference = await store.put(long, key, 'one');
    expect(reference.key).toBe(id);
    expect(api.annotationsOf(id)).toMatchObject({ 'spindrift-key': key });
    expect((await store.describe(reference))?.key).toBe(key);
  });

  test('truncated ids keep two long scopes apart', async () => {
    // Every id below is truncated and identical past the cut, so only the
    // digest of the exact scope tells them apart.
    const long = { app: 'a'.repeat(240), component: 'web', target: 'metal' };

    expect(secretIdFor(long, 'TOKEN')).not.toBe(
      secretIdFor({ ...long, component: 'worker' }, 'TOKEN'),
    );
    // Sanitizing maps `.` and `/` to one character; the digest still differs.
    expect(secretIdFor({ ...long, app: `${long.app}.` }, 'TOKEN')).not.toBe(
      secretIdFor({ ...long, app: `${long.app}/` }, 'TOKEN'),
    );
  });

  test('records the exact scope as annotations', async () => {
    const { api, store } = secretManager();
    const reference = await store.put(scope, 'DATABASE_URL', 'one');

    // The id is only a legible name; `describe` reads the variable back from
    // the annotations.
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

    // Sanitizing is lossy, so two scopes can share an id. Writing anyway would
    // hand one Component's value to another.
    expect(store.put(scope, 'DATABASE_URL', 'one')).rejects.toThrow(
      /belongs to/,
    );
  });

  test('pages through every version it has written', async () => {
    const { api, store } = secretManager();
    for (const value of ['one', 'two', 'three', 'four', 'five']) {
      await store.put(scope, 'DATABASE_URL', value);
    }

    // The fake pages at two, so five versions span three pages.
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

// These drive the fakes directly: a fake more permissive than the real API
// turns a production bug into a green test.
describe('the store fakes refuse what the real APIs refuse', () => {
  test('Secret Manager refuses an id outside its alphabet or ceiling', async () => {
    const api = new FakeSecretManager();
    for (const id of ['has/slash', 'has.dot', 'x'.repeat(256), '']) {
      const response = await api.fetch(
        new Request(
          `${api.baseUrl}/v1/projects/${api.project}/secrets?secretId=${encodeURIComponent(id)}`,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer federated-token' },
            body: JSON.stringify({ replication: { automatic: {} } }),
          },
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(api.secretCount).toBe(0);
  });

  test('Secret Manager refuses a create with no replication policy', async () => {
    const api = new FakeSecretManager();
    for (const body of [{}, { replication: {} }]) {
      const response = await api.fetch(
        new Request(
          `${api.baseUrl}/v1/projects/${api.project}/secrets?secretId=fine`,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer federated-token' },
            body: JSON.stringify(body),
          },
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(api.secretCount).toBe(0);
  });

  test('Connect refuses a create with no vault or no category', async () => {
    const connect = new FakeOnePasswordConnect();
    const bodies = [
      { title: 'invoices/web/metal/TOKEN', category: 'API_CREDENTIAL' },
      { title: 'invoices/web/metal/TOKEN', vault: { id: connect.vault } },
      {
        title: 'invoices/web/metal/TOKEN',
        vault: { id: 'another-vault' },
        category: 'API_CREDENTIAL',
      },
      {
        title: 'invoices/web/metal/TOKEN',
        vault: { id: connect.vault },
        category: 'NOT_A_CATEGORY',
      },
    ];
    for (const body of bodies) {
      const response = await connect.fetch(
        new Request(`${connect.baseUrl}/v1/vaults/${connect.vault}/items`, {
          method: 'POST',
          headers: { Authorization: 'Bearer connect-token' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
    }
    expect(connect.itemCount).toBe(0);
  });
});
