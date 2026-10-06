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
const SPLIT = [
  { name: ZONE, reaches: ['private'] },
  { name: VANITY_ZONE, reaches: ['public'] },
] as const;

describe('§9: one label under the zone, both layers', () => {
  test('a minted name is flat, and leads with the App', () => {
    expect(
      componentCanonical({ app: 'shop', component: 'web', zone: ZONE }),
    ).toBe('shop-web.apps.example.test');
    // A wildcard certificate covers one label, and leading with the App sorts
    // its Components together in a zone listing.
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
    // An empty label would read as no vanity name, so the apex is spelled @.
    expect(vanity(APEX, VANITY_ZONE)).toBe(VANITY_ZONE);
    expect(isVanityLabel(APEX)).toBe(true);
    expect(isVanityLabel('shop')).toBe(true);
    expect(isVanityLabel('shop.web')).toBe(false);
    expect(isVanityLabel('')).toBe(false);
  });

  test('and it is recognisable as one afterwards, from the name alone', () => {
    // Screens and the deploy log hold the resolved name, not the chosen label.
    const zones = [
      { name: VANITY_ZONE, reaches: ['public'] },
      { name: 'other.example.test', reaches: ['public'] },
    ] as const;

    expect(isApexName(vanity(APEX, VANITY_ZONE), zones)).toBe(true);
    expect(isApexName(VANITY_ZONE, zones)).toBe(true);
    expect(isApexName('other.example.test', zones)).toBe(true);
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
    const many = [
      { name: 'first.example.test', reaches: ['private', 'public'] },
      { name: 'shop.example.test', reaches: ['public'] },
    ] as const;
    expect(zoneFor('private', many, 'shop.example.test')).toBe(
      'first.example.test',
    );
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
    // A second address would leave the App with two URLs and no answer about
    // which is real.
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
    expect(hostname.vanity).toBe('shop.sh.example.test');
  });

  test('a minted name carries the vanity name too, on the same Target', () => {
    // A minted name is never www or the apex, which a cluster App wants too.
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
    expect(displayUrl({ canonical: '' })).toBeNull();
  });
});

describe('§9: the vanity layer, and what it costs', () => {
  test('the canonical is minted exactly where the platform names its own; the vanity layer is not', () => {
    for (const adapter of ['cloudrun', 'static'] as const) {
      expect(coreMintsCanonical(adapter)).toBe(false);
    }
    expect(coreMintsCanonical('kubernetes')).toBe(true);
  });

  test('the losses on the proxied leg are stated, not worked around', () => {
    expect(VANITY_LEG_LOSSES.buffersResponse).toBe(true);
    expect(VANITY_LEG_LOSSES.streamingProtocols).toBe(false);
    expect(VANITY_LEG_LOSSES.maxRequestSeconds).toBe(60);
  });

  test('moving between backends re-points one record and renames nothing', () => {
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
      // The platform's own name arrives from the deploy adapter.
      expect(hostname.canonical).toBe('');
    }
  });
});
