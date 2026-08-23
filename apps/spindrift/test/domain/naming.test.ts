/**
 * Naming (Task 21, §9).
 *
 * **Both layers are flat, and for one reason: a wildcard certificate binds
 * exactly one label.** `plainboi-web.zone` is covered by `*.zone` and
 * `web.plainboi.zone` is not, which is what the first LIVE Deploy hit. So the
 * nesting the canonical layer once allowed is gone.
 *
 * **The vanity layer is the App's own name, on every Target (ticket 137).**
 * Ticket 43's "where core mints, it can simply mint a good one" still decides
 * {@link coreMintsCanonical} — nothing here reopens that — but it never bounded
 * the vanity layer, which mints `www` and the bare apex, `@`, neither of which
 * a minted `<app>-<component>.<zone>` can ever be.
 *
 * **What core mints is a name, never a record.** The record each name answers
 * to is the App chart's `DNSEndpoint`, asserted by
 * `packages/charts/spindrift-app/tests/render.test.ts`, because `reach` decides
 * the record type and only the chart holds the values that decision needs.
 * `test/extraction/no-dns-credential.test.ts` is the grep that keeps the other
 * half of §9 true — that no zone credential ever arrives here.
 */
import { describe, expect, test } from 'bun:test';
import {
  APEX,
  componentCanonical,
  coreMintsCanonical,
  displayUrl,
  hostnameFor,
  isApexName,
  isLabel,
  isVanityLabel,
  VANITY_LEG_LOSSES,
  vanity,
  zoneFor,
} from '../../src/domain/naming.ts';

const ZONE = 'apps.example.test';
const VANITY_ZONE = 'sh.example.test';
const ZONES = [{ name: ZONE, reaches: ['private', 'public'] }] as const;
/** An installation that split its reaches across two zones (§9). */
const SPLIT = [
  { name: ZONE, reaches: ['private'] },
  { name: VANITY_ZONE, reaches: ['public'] },
] as const;

describe('§9: one label under the zone, both layers', () => {
  test('a minted name is flat, and leads with the App', () => {
    expect(
      componentCanonical({ app: 'shop', component: 'web', zone: ZONE }),
    ).toBe('shop-web.apps.example.test');
    // Flat because a wildcard certificate binds one label. Leading with the App
    // so an App's Components sort together in a zone listing.
    expect(isLabel('shop-web')).toBe(true);
  });

  test('a vanity name is one flat label in its zone', () => {
    expect(vanity('shop', VANITY_ZONE)).toBe('shop.sh.example.test');
    expect(isLabel('shop')).toBe(true);
    expect(isLabel('my-shop')).toBe(true);
    expect(isLabel('shop.web')).toBe(false);
    expect(isLabel('-shop')).toBe(false);
    expect(isLabel('')).toBe(false);
  });

  test('the apex is the one vanity name with no label at all', () => {
    // A vanity name is otherwise a label joined with a dot, which is why the
    // bare zone needed a spelling of its own — `@`, DNS-zone style — rather
    // than an empty label indistinguishable from asking for none.
    expect(vanity(APEX, VANITY_ZONE)).toBe(VANITY_ZONE);
    expect(isVanityLabel(APEX)).toBe(true);
    expect(isVanityLabel('shop')).toBe(true);
    expect(isVanityLabel('shop.web')).toBe(false);
    expect(isVanityLabel('')).toBe(false);
  });

  test('and it is recognisable as one afterwards, from the name alone', () => {
    // The screens and the deploy log both have to say that an apex record is
    // published once and never re-pointed, and neither of them holds the label
    // it was chosen with — they hold the name it resolved to. So the question
    // is asked of the name: `@` in this zone and the zone typed out in full are
    // the same string and the same one-way door.
    const zones = [
      { name: VANITY_ZONE, reaches: ['public'] },
      { name: 'other.example.test', reaches: ['public'] },
    ] as const;

    expect(isApexName(vanity(APEX, VANITY_ZONE), zones)).toBe(true);
    expect(isApexName(VANITY_ZONE, zones)).toBe(true);
    expect(isApexName('other.example.test', zones)).toBe(true);
    // A label under a zone is not an apex, and neither is a zone this
    // installation does not hold.
    expect(isApexName(vanity('shop', VANITY_ZONE), zones)).toBe(false);
    expect(isApexName('example.test', zones)).toBe(false);
    expect(isApexName('', zones)).toBe(false);
  });
});

describe('§9: core mints a name only where the platform gives none', () => {
  test('a cluster gets a minted canonical', () => {
    expect(coreMintsCanonical('kubernetes')).toBe(true);
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      reach: 'private',
      zones: ZONES,
      zone: null,
      vanityLabel: null,
    });
    expect(hostname.canonical).toBe('shop-web.apps.example.test');
    expect(hostname.vanity).toBeUndefined();
  });

  test('a Component with no reach gets no name at all', () => {
    // Nothing routes to it, so every name core could mint would resolve to
    // something unreachable. The absence is the answer, not a gap.
    expect(zoneFor('none', ZONES)).toBeNull();
    for (const adapter of ['kubernetes', 'cloudrun', 'static'] as const) {
      const hostname = hostnameFor({
        app: 'shop',
        component: 'web',
        adapter,
        reach: 'none',
        zones: ZONES,
        zone: null,
        vanityLabel: 'shop',
      });
      expect(hostname.canonical).toBe('');
      expect(hostname.vanity).toBeUndefined();
      expect(displayUrl(hostname)).toBeNull();
    }
  });

  test('each reach picks its own zone', () => {
    const split = [
      { name: 'lan.example.test', reaches: ['private'] },
      { name: 'www.example.test', reaches: ['public'] },
    ] as const;
    expect(zoneFor('private', split)).toBe('lan.example.test');
    expect(zoneFor('public', split)).toBe('www.example.test');
  });

  test('an App pins a zone, and the pin wins over the default', () => {
    // The reason `dns.zones` is a list: an installation with more than one
    // public zone has no way to say which one an App answers on unless the App
    // can name it. Unpinned takes the head of the list, which is what every
    // App got when reach alone named the zone.
    const many = [
      { name: 'first.example.test', reaches: ['private', 'public'] },
      { name: 'second.example.test', reaches: ['private', 'public'] },
      { name: 'shop.example.test', reaches: ['public'] },
    ] as const;
    expect(zoneFor('public', many)).toBe('first.example.test');
    expect(zoneFor('public', many, 'shop.example.test')).toBe(
      'shop.example.test',
    );
    expect(zoneFor('private', many, 'second.example.test')).toBe(
      'second.example.test',
    );
  });

  test('a pin that cannot serve the reach falls through rather than lying', () => {
    // A public-only zone has no private boundary to publish on, so minting
    // there would put a record on an address the operator said that zone does
    // not answer at. The fall-through is §9's rename, and it is visible: the
    // name this returns is the name the UI shows.
    const many = [
      { name: 'first.example.test', reaches: ['private', 'public'] },
      { name: 'shop.example.test', reaches: ['public'] },
    ] as const;
    expect(zoneFor('private', many, 'shop.example.test')).toBe(
      'first.example.test',
    );
    // And a reach no zone serves has no name at all, for the same reason
    // `reach: none` does not: there is nothing honest to call it.
    expect(
      zoneFor('private', [{ name: 'shop.example.test', reaches: ['public'] }]),
    ).toBeNull();
  });

  test('a pin follows the App onto a minted name', () => {
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      reach: 'public',
      zones: [
        { name: 'first.example.test', reaches: ['private', 'public'] },
        { name: 'shop.example.test', reaches: ['public'] },
      ],
      zone: 'shop.example.test',
      vanityLabel: null,
    });
    expect(hostname.canonical).toBe('shop-web.shop.example.test');
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
        reach: 'public',
        zones: ZONES,
        zone: null,
        vanityLabel: null,
      });
      expect(hostname.canonical).toBe('');
    }
  });

  test('a vanity label rides a backend that names its own workload too', () => {
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'cloudrun',
      reach: 'public',
      zones: SPLIT,
      zone: null,
      vanityLabel: 'shop',
    });
    // Vanity is backend-agnostic on purpose: moving an App between backends is
    // one record re-point, so the name a developer shares does not change.
    expect(hostname.vanity).toBe('shop.sh.example.test');
  });

  test('a minted name carries the vanity name too, on the same Target', () => {
    // Ticket 43's reasoning bounds `canonical`, not `vanity`: a minted name is
    // never `www` or the bare apex, and a cluster App wants one of those
    // exactly as much as a Cloud Run App does.
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      reach: 'private',
      zones: ZONES,
      zone: null,
      vanityLabel: 'shop',
    });
    expect(hostname.canonical).toBe('shop-web.apps.example.test');
    expect(hostname.vanity).toBe('shop.apps.example.test');
  });

  test('a kubernetes Target can vanity-name the apex too', () => {
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      reach: 'public',
      zones: SPLIT,
      zone: null,
      vanityLabel: APEX,
    });
    expect(hostname.canonical).toBe('shop-web.sh.example.test');
    expect(hostname.vanity).toBe('sh.example.test');
  });

  test('the address shown prefers the vanity name, and is null when there is none', () => {
    expect(displayUrl({ canonical: 'shop-web.apps.example.test' })).toBe(
      'https://shop-web.apps.example.test',
    );
    expect(
      displayUrl({
        canonical: 'shop-web.apps.example.test',
        vanity: 'shop.sh.example.test',
      }),
    ).toBe('https://shop.sh.example.test');
    // A Deploy that has not reached a Target has no address, and inventing one
    // would make a pending deploy look live.
    expect(displayUrl({ canonical: '' })).toBeNull();
  });
});

describe('§9: the vanity layer, and what it costs', () => {
  test('the canonical is minted exactly where the platform names its own; the vanity layer is not', () => {
    // The certificate ration that once bounded both is gone with the
    // Universal-SSL fact that produced it: a cert-manager wildcard has no such
    // limit. `coreMintsCanonical` still narrows to these two — that reasoning
    // was always about the canonical — but it was never a reason to narrow the
    // vanity layer with it, which is what ticket 137 undoes.
    for (const adapter of ['cloudrun', 'static'] as const) {
      expect(coreMintsCanonical(adapter)).toBe(false);
    }
    expect(coreMintsCanonical('kubernetes')).toBe(true);
  });

  test('the losses on the proxied leg are stated, not worked around', () => {
    // §9 absorbs these on purpose, and the reason it can is that the app stays
    // fully capable at its canonical name. Working around them would mean a
    // second edge, which is the external load balancer §9 declines to have.
    expect(VANITY_LEG_LOSSES.buffersResponse).toBe(true);
    expect(VANITY_LEG_LOSSES.streamingProtocols).toBe(false);
    expect(VANITY_LEG_LOSSES.maxRequestSeconds).toBe(60);
  });

  test('moving between backends re-points one record and renames nothing', () => {
    // §9's whole reason for a second layer: "the name a developer shares is
    // backend-agnostic and moving an App between backends is one record
    // re-point." So the name is a function of the label and the zone alone —
    // if the adapter appeared in it, a move would change what people had
    // bookmarked.
    const shared = vanity('shop', VANITY_ZONE);
    for (const adapter of ['cloudrun', 'static'] as const) {
      const hostname = hostnameFor({
        app: 'shop',
        component: 'web',
        adapter,
        reach: 'public',
        zones: SPLIT,
        zone: null,
        vanityLabel: 'shop',
      });
      expect(hostname.vanity).toBe(shared);
      // The canonical underneath it is the platform's own name, arriving across
      // the deploy seam rather than being minted here.
      expect(hostname.canonical).toBe('');
    }
  });
});
