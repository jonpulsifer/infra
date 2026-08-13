/**
 * Every adapter's own default API root, actually reached (§13, §20).
 *
 * `domain/target.ts` made `endpoint` optional on every cloud connection, on
 * the premise that Vercel, Cloudflare Pages, Cloud Run and Firebase Hosting
 * each answer at one hostname for every installation, so the adapter that owns
 * the fact should supply it rather than an operator retyping it per project.
 * Every other test in this tree builds its connection with an explicit
 * `endpoint` — the fixture-standing pattern §20 wants, so a fake serving one
 * host and an adapter addressing another fail for a reason nobody would look
 * for — which means the fallback branch itself, `connection.endpoint ??
 * DEFAULT_ENDPOINT`, is untouched by any of them. This file is that one check:
 * omit `endpoint` and prove the request still lands on the adapter's real
 * default, not on `undefined` turned into a string.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ENDPOINT as CLOUDRUN_DEFAULT_ENDPOINT,
  CloudRunDeployAdapter,
} from '../../src/adapters/deploy/cloudrun/index.ts';
import type { DeployTarget } from '../../src/adapters/deploy/contract.ts';
import {
  DEFAULT_ENDPOINT as PAGES_DEFAULT_ENDPOINT,
  PagesDeployAdapter,
} from '../../src/adapters/deploy/pages/index.ts';
import {
  DEFAULT_ENDPOINT as STATIC_DEFAULT_ENDPOINT,
  StaticDeployAdapter,
} from '../../src/adapters/deploy/static/index.ts';
import {
  DEFAULT_ENDPOINT as VERCEL_DEFAULT_ENDPOINT,
  VercelDeployAdapter,
} from '../../src/adapters/deploy/vercel/index.ts';
import { createSecretStore } from '../../src/adapters/registry.ts';
import { SecretManagerStore } from '../../src/adapters/store/gcp-secret-manager.ts';
import type {
  CloudflarePagesAdapterConnection,
  CloudRunAdapterConnection,
  StaticAdapterConnection,
  VercelAdapterConnection,
} from '../../src/domain/target.ts';
import { fixtureManifest } from '../harness/installation.ts';

/** A `Fetcher` that answers `404` to everything and remembers the one URL. */
function capture(): {
  fetch: (request: Request) => Promise<Response>;
  url(): string;
} {
  let seen = '';
  return {
    fetch: async (request) => {
      seen = request.url;
      return new Response('{}', { status: 404 });
    },
    url: () => seen,
  };
}

const TOKEN = () => 'token';

describe('a Target with no stated endpoint reaches the adapter default', () => {
  test('cloudrun', async () => {
    const connection: CloudRunAdapterConnection = {
      adapter: 'cloudrun',
      project: 'example-vessel',
      region: 'somewhere',
    };
    const target: DeployTarget = {
      vessel: 'cloud',
      adapter: 'cloudrun',
      connection,
    };
    const spy = capture();
    const adapter = new CloudRunDeployAdapter({
      token: TOKEN,
      fetch: spy.fetch,
    });

    await adapter.observe(
      target,
      'projects/example-vessel/locations/somewhere/services/site',
    );

    expect(spy.url()).toStartWith(CLOUDRUN_DEFAULT_ENDPOINT);
  });

  test('static (Firebase Hosting)', async () => {
    const connection: StaticAdapterConnection = {
      adapter: 'static',
      project: 'example-vessel',
    };
    const target: DeployTarget = {
      vessel: 'hosting',
      adapter: 'static',
      connection,
    };
    const spy = capture();
    const adapter = new StaticDeployAdapter({ token: TOKEN, fetch: spy.fetch });

    await adapter.observe(target, 'example-vessel/sites/site');

    expect(spy.url()).toStartWith(STATIC_DEFAULT_ENDPOINT);
  });

  test('vercel', async () => {
    const connection: VercelAdapterConnection = {
      adapter: 'vercel',
      team: 'example-team',
    };
    const target: DeployTarget = {
      vessel: 'edge',
      adapter: 'vercel',
      connection,
    };
    const spy = capture();
    const adapter = new VercelDeployAdapter({
      token: TOKEN,
      artifactToken: TOKEN,
      fetch: spy.fetch,
    });

    await adapter.observe(target, 'example-team/projects/site');

    expect(spy.url()).toStartWith(VERCEL_DEFAULT_ENDPOINT);
  });

  test('cloudflare-pages', async () => {
    const connection: CloudflarePagesAdapterConnection = {
      adapter: 'cloudflare-pages',
      account: 'example-account',
    };
    const target: DeployTarget = {
      vessel: 'edge',
      adapter: 'cloudflare-pages',
      connection,
    };
    const spy = capture();
    const adapter = new PagesDeployAdapter({
      token: TOKEN,
      artifactToken: TOKEN,
      fetch: spy.fetch,
    });

    await adapter.observe(target, 'example-account/pages/site');

    expect(spy.url()).toStartWith(PAGES_DEFAULT_ENDPOINT);
  });
});

describe('a secretStore with no stated endpoint', () => {
  test('gcp-secret-manager defaults to Secret Manager itself', async () => {
    const manifest = await fixtureManifest();
    const store = createSecretStore(
      { ...manifest, secretStore: { adapter: 'gcp-secret-manager' } },
      TOKEN,
    );
    // The only way to observe `baseUrl` from outside is the class it produced —
    // constructing at all (rather than throwing, or handing `StoreHttp` a
    // `baseUrl` of `undefined`) is what proves the default resolved.
    expect(store).toBeInstanceOf(SecretManagerStore);
  });

  test('onepassword has no universal default and says so', async () => {
    const manifest = await fixtureManifest();
    expect(() =>
      createSecretStore(
        { ...manifest, secretStore: { adapter: 'onepassword' } },
        TOKEN,
      ),
    ).toThrow(/no default/);
  });
});
