/**
 * Naming (Task 21, §9).
 *
 * **Both layers are flat now, and for one reason: a wildcard certificate binds
 * exactly one label.** `plainboi-web.zone` is covered by `*.zone` and
 * `web.plainboi.zone` is not, which is what the first LIVE Deploy hit. So the
 * nesting the canonical layer used to be allowed is gone, and what survives of
 * the vanity layer is the case where core does not mint the first name at all.
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
  componentCanonical,
  coreMintsCanonical,
  displayUrl,
  hostnameFor,
  isLabel,
  VANITY_LEG_LOSSES,
  vanity,
  zoneForReach,
} from '../../src/domain/naming.ts';

const APEX = 'apps.example.test';
const VANITY_ZONE = 'sh.example.test';
const ZONES = { private: APEX, public: APEX } as const;

describe('§9: one label under the zone, both layers', () => {
  test('a minted name is flat, and leads with the App', () => {
    expect(
      componentCanonical({ app: 'shop', component: 'web', zone: APEX }),
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
      vanityLabel: null,
    });
    expect(hostname.canonical).toBe('shop-web.apps.example.test');
    expect(hostname.vanity).toBeUndefined();
  });

  test('a Component with no reach gets no name at all', () => {
    // Nothing routes to it, so every name core could mint would resolve to
    // something unreachable. The absence is the answer, not a gap.
    expect(zoneForReach('none', ZONES)).toBeNull();
    for (const adapter of ['kubernetes', 'cloudrun', 'static'] as const) {
      const hostname = hostnameFor({
        app: 'shop',
        component: 'web',
        adapter,
        reach: 'none',
        zones: ZONES,
        vanityLabel: 'shop',
      });
      expect(hostname.canonical).toBe('');
      expect(hostname.vanity).toBeUndefined();
      expect(displayUrl(hostname)).toBeNull();
    }
  });

  test('each reach picks its own zone', () => {
    const split = { private: 'lan.example.test', public: 'www.example.test' };
    expect(zoneForReach('private', split)).toBe('lan.example.test');
    expect(zoneForReach('public', split)).toBe('www.example.test');
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
        vanityLabel: null,
      });
      expect(hostname.canonical).toBe('');
    }
  });

  test('a vanity label is layered on only where core mints nothing', () => {
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'cloudrun',
      reach: 'public',
      zones: { private: APEX, public: VANITY_ZONE },
      vanityLabel: 'shop',
    });
    // Vanity is backend-agnostic on purpose: moving an App between backends is
    // one record re-point, so the name a developer shares does not change.
    expect(hostname.vanity).toBe('shop.sh.example.test');
  });

  test('a minted name is not layered over, because it is already good', () => {
    // Where core mints, a second flat name in the same zone would be an alias
    // for something already flat.
    const hostname = hostnameFor({
      app: 'shop',
      component: 'web',
      adapter: 'kubernetes',
      reach: 'private',
      zones: ZONES,
      vanityLabel: 'shop',
    });
    expect(hostname.vanity).toBeUndefined();
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
  test('the layer survives exactly where the platform names its own', () => {
    // The certificate ration is gone with the Universal-SSL fact that produced
    // it: a cert-manager wildcard has no such limit. What is left of the layer
    // is the case it was always best at — putting a flat name over
    // `plainboi-web-xyz.run.app`.
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
        zones: { private: APEX, public: VANITY_ZONE },
        vanityLabel: 'shop',
      });
      expect(hostname.vanity).toBe(shared);
      // The canonical underneath it is the platform's own name, arriving across
      // the deploy seam rather than being minted here.
      expect(hostname.canonical).toBe('');
    }
  });
});
