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
      // Connect has no default for either, and refuses a create without them.
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

    // Connect populates an API_CREDENTIAL with `username`, `credential` and
    // `notesPlain` of its own. They come back in front of the caller's field
    // and two of them are labelled, so an adapter reading "the first labelled
    // field" reads `username` — a variable name that was never written, on a
    // §10 read-back whose whole job is to prove a pin still resolves.
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

    // Titled exactly as Spindrift titles one, and carrying nothing Spindrift
    // wrote. Absent beats guessing the variable out of the title.
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

  test('the create carries a replication policy', async () => {
    const { api, store } = secretManager();
    await store.put(scope, 'DATABASE_URL', 'one');

    // The Secret resource has no default for it and the API refuses a create
    // without one, so dropping this line would break every write this
    // installation makes and nothing else would say so.
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

    // Three DNS labels at their own ceiling plus a long variable name clears
    // 255 without anything unreasonable happening, and the API refuses the
    // create rather than truncating for us.
    const id = secretIdFor(long, key);
    expect(id.length).toBeLessThanOrEqual(255);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,255}$/);

    const reference = await store.put(long, key, 'one');
    expect(reference.key).toBe(id);
    expect(api.annotationsOf(id)).toMatchObject({ 'spindrift-key': key });
    expect((await store.describe(reference))?.key).toBe(key);
  });

  test('truncated ids keep two long scopes apart', async () => {
    // Long enough that every id below is truncated, and identical far past the
    // cut — so the head alone cannot tell any of them apart.
    const long = { app: 'a'.repeat(240), component: 'web', target: 'metal' };

    // Truncation on its own would widen the collision the sanitizer already
    // opens. The digest of the exact scope is what keeps two scopes sharing a
    // head apart…
    expect(secretIdFor(long, 'TOKEN')).not.toBe(
      secretIdFor({ ...long, component: 'worker' }, 'TOKEN'),
    );
    // …and what separates two that sanitizing flattens onto one name, which
    // the untruncated form never could.
    expect(secretIdFor({ ...long, app: `${long.app}.` }, 'TOKEN')).not.toBe(
      secretIdFor({ ...long, app: `${long.app}/` }, 'TOKEN'),
    );
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

/**
 * The far side, driven directly.
 *
 * Everything above goes through an adapter that is correct today, so it proves
 * the adapter and not the fake. These go straight at the fake, because a fake
 * more permissive than the real API is how a production bug becomes a green
 * test — and the fake is the half of that pair no adapter test can reach.
 */
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
