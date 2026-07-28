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
  componentCanonical,
  coreMintsCanonical,
  displayUrl,
  hostnameFor,
  isLabel,
  VANITY_CEILING,
  VANITY_LEG_LOSSES,
  vanity,
  vanityCarriesStreams,
  vanityProxied,
  vanityRation,
} from '../../src/domain/naming.ts';

const APEX = 'apps.example.test';
const VANITY_ZONE = 'sh.example.test';

describe('§9: two layers, two different rules', () => {
  test('canonical names nest, because they are not proxied', () => {
    expect(
      componentCanonical({ app: 'shop', component: 'web', apexZone: APEX }),
    ).toBe('web.shop.apps.example.test');
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

describe('§9: the vanity layer, and what it costs', () => {
  test('the ceiling is a fact about the certificate, reported not enforced', () => {
    // §9's "hard ceiling: roughly 20 vanity names" is a property of one apex's
    // free certificate. Nothing here refuses the twenty-first: the UI's job is
    // to say how many are left, and a limit core imposed would be a policy
    // somebody chose rather than the one the zone actually has.
    expect(vanityRation(0)).toEqual({
      used: 0,
      ceiling: VANITY_CEILING,
      remaining: VANITY_CEILING,
      exhausted: false,
    });
    expect(vanityRation(VANITY_CEILING).exhausted).toBe(true);
    expect(vanityRation(VANITY_CEILING + 5).remaining).toBe(0);
  });

  test('proxying is per-Target, and follows who mints the canonical name', () => {
    // §9: "the vanity record is unproxied on that leg, **so** proxying becomes
    // a per-Target property." The proxy is not a preference — it is the only
    // way a name reaches a cluster whose load-balancer range is RFC1918.
    expect(vanityProxied('kubernetes')).toBe(true);
    for (const adapter of ['cloudrun', 'static'] as const) {
      expect(vanityProxied(adapter)).toBe(false);
      // The two are the same question asked twice: a backend that names its
      // own workloads is a backend the internet already reaches.
      expect(coreMintsCanonical(adapter)).toBe(false);
    }
  });

  test('the losses on the unproxied leg are stated, not worked around', () => {
    // §9 absorbs these on purpose, and the reason it can is that the app stays
    // fully capable at its canonical name. Working around them would mean a
    // second edge, which is the external load balancer §9 declines to have.
    expect(VANITY_LEG_LOSSES.buffersResponse).toBe(true);
    expect(VANITY_LEG_LOSSES.streamingProtocols).toBe(false);
    expect(VANITY_LEG_LOSSES.maxRequestSeconds).toBe(60);
  });

  test('an App that streams keeps its streams only on the proxied leg', () => {
    expect(vanityCarriesStreams('kubernetes')).toBe(true);
    expect(vanityCarriesStreams('cloudrun')).toBe(false);
    expect(vanityCarriesStreams('static')).toBe(false);
  });

  test('moving between backends re-points one record and renames nothing', () => {
    // §9's whole reason for a second layer: "the name a developer shares is
    // backend-agnostic and moving an App between backends is one record
    // re-point." So the name is a function of the label and the zone alone —
    // if the adapter appeared in it, a move would change what people had
    // bookmarked.
    const shared = vanity('shop', VANITY_ZONE);
    for (const adapter of ['kubernetes', 'cloudrun', 'static'] as const) {
      const hostname = hostnameFor({
        app: 'shop',
        component: 'web',
        adapter,
        apexZone: APEX,
        vanityZone: VANITY_ZONE,
        vanityLabel: 'shop',
      });
      expect(hostname.vanity).toBe(shared);
      // What does change is the canonical underneath it, and on two of the
      // three that is the platform's own name arriving across the deploy seam.
      expect(hostname.canonical === '').toBe(!coreMintsCanonical(adapter));
    }
  });
});
