/**
 * Naming and DNS (Task 21, §9).
 *
 * §9's two layers differ in a way that is easy to collapse by accident, so both
 * halves are asserted: canonical names **nest freely** because they are not
 * proxied, and vanity names are **flat single-label** because one apex's free
 * certificate covers exactly one subdomain level. A canonical name that had been
 * flattened to fit the vanity rule would work fine and quietly spend the ration.
 *
 * The other claim here is negative and therefore needs a test that can fail:
 * **Spindrift holds no Cloudflare credential** (§9 — "Spindrift writes DNS as CRs
 * the DNS controller publishes"). `test/extraction/no-dns-credential.test.ts` is
 * the grep that notices if one ever arrives.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TTL_SECONDS,
  DNS_ENDPOINT_API_VERSION,
  DNS_ENDPOINT_KIND,
  dnsEndpointFor,
  recordsFor,
} from '../../src/adapters/dns/cr.ts';
import {
  appCanonical,
  componentCanonical,
  coreMintsCanonical,
  displayUrl,
  hostnameFor,
  isLabel,
  vanity,
} from '../../src/domain/naming.ts';

const APEX = 'apps.example.test';
const VANITY_ZONE = 'sh.example.test';

describe('§9: two layers, two different rules', () => {
  test('canonical names nest, because they are not proxied', () => {
    expect(
      componentCanonical({ app: 'shop', component: 'web', apexZone: APEX }),
    ).toBe('web.shop.apps.example.test');
    expect(appCanonical('shop', APEX)).toBe('shop.apps.example.test');
  });

  test('a vanity name is one flat label in the vanity zone', () => {
    expect(vanity('shop', VANITY_ZONE)).toBe('shop.sh.example.test');
    // The ration §9 names — "roughly 20" — is a property of one apex's
    // certificate, and a dotted vanity name would silently need a second one.
    expect(isLabel('shop')).toBe(true);
    expect(isLabel('my-shop')).toBe(true);
    expect(isLabel('shop.web')).toBe(false);
    expect(isLabel('-shop')).toBe(false);
    expect(isLabel('')).toBe(false);
  });
});

describe('§9: core mints a name only where the platform gives none', () => {
  test('a cluster gets a minted canonical', () => {
    expect(coreMintsCanonical('kubernetes')).toBe(true);
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      apexZone: APEX,
      vanityZone: VANITY_ZONE,
      vanityLabel: null,
    });
    expect(hostname.canonical).toBe('web.shop.apps.example.test');
    expect(hostname.vanity).toBeUndefined();
  });

  test('the backends that name their own workloads get none from core', () => {
    // §9: "where the platform gives one of its own, that *is* the canonical."
    // Minting a second address for something that already has one is how an App
    // ends up with two URLs and no answer about which is real.
    for (const adapter of ['cloudrun', 'static'] as const) {
      expect(coreMintsCanonical(adapter)).toBe(false);
      const hostname = hostnameFor({
        app: 'shop',
        component: 'web',
        adapter,
        apexZone: APEX,
        vanityZone: VANITY_ZONE,
        vanityLabel: null,
      });
      expect(hostname.canonical).toBe('');
    }
  });

  test('a vanity label is layered on wherever one was chosen', () => {
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'cloudrun',
      apexZone: APEX,
      vanityZone: VANITY_ZONE,
      vanityLabel: 'shop',
    });
    // Vanity is backend-agnostic on purpose: moving an App between backends is
    // one record re-point, so the name a developer shares does not change.
    expect(hostname.vanity).toBe('shop.sh.example.test');
  });

  test('the address shown prefers the vanity name, and is null when there is none', () => {
    expect(displayUrl({ canonical: 'web.shop.apps.example.test' })).toBe(
      'https://web.shop.apps.example.test',
    );
    expect(
      displayUrl({
        canonical: 'web.shop.apps.example.test',
        vanity: 'shop.sh.example.test',
      }),
    ).toBe('https://shop.sh.example.test');
    // A Deploy that has not reached a Target has no address, and inventing one
    // would make a pending deploy look live.
    expect(displayUrl({ canonical: '' })).toBeNull();
  });
});

describe('§9: DNS is a custom resource, not an API call', () => {
  test('a DNSEndpoint carries the records and nothing else', () => {
    const object = dnsEndpointFor({
      name: 'shop-web',
      namespace: 'app-shop',
      records: recordsFor({
        canonical: 'web.shop.apps.example.test',
        vanity: 'shop.sh.example.test',
        servedBy: 'tunnel.example.test',
      }),
      labels: { 'app.spindrift/app': 'shop' },
    });

    expect(object.apiVersion).toBe(DNS_ENDPOINT_API_VERSION);
    expect(object.kind).toBe(DNS_ENDPOINT_KIND);
    // Namespaced, which is what buys §9's "garbage collection free": deleting
    // the App's namespace deletes its records, so core keeps no list of names
    // it once minted.
    expect(object.metadata.namespace).toBe('app-shop');
    expect(object.spec).toEqual({
      endpoints: [
        {
          dnsName: 'web.shop.apps.example.test',
          recordType: 'CNAME',
          targets: ['tunnel.example.test'],
          recordTTL: DEFAULT_TTL_SECONDS,
        },
        {
          dnsName: 'shop.sh.example.test',
          recordType: 'CNAME',
          targets: ['tunnel.example.test'],
          recordTTL: DEFAULT_TTL_SECONDS,
        },
      ],
    });
  });

  test('no vanity name means no vanity record', () => {
    // Not a record pointing at the canonical: §9 layers vanity on "where a
    // mechanism exists", so an installation without one has an App with one
    // name rather than two names that mean the same thing.
    const records = recordsFor({
      canonical: 'web.shop.apps.example.test',
      servedBy: 'tunnel.example.test',
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.dnsName).toBe('web.shop.apps.example.test');
  });

  test('records are CNAMEs, never A records at an address core does not own', () => {
    // §9's forcing fact: the metal cluster's load-balancer range is RFC1918, so
    // an A record here would publish an address the internet cannot route to.
    const records = recordsFor({
      canonical: 'web.shop.apps.example.test',
      servedBy: 'tunnel.example.test',
    });
    expect(records.every((record) => record.recordType === 'CNAME')).toBe(true);
  });
});
