import { describe, expect, test } from 'bun:test';
import { kthxLabels, kthxNamesOf } from '../../src/commands/apps/kthx-names.ts';
import type { DnsZones } from '../../src/domain/naming.ts';

const ZONE = 'kthx.example.test';

describe('kthxLabels', () => {
  test('keeps each single label under the zone, de-duplicated and sorted', () => {
    expect(
      kthxLabels(
        [
          `shop-web.${ZONE}`,
          `acme.${ZONE}`,
          `shop-web.${ZONE}`,
          `ACME.${ZONE.toUpperCase()}`,
        ],
        ZONE,
      ),
    ).toEqual(['acme', 'shop-web']);
  });

  test('ignores other zones, the apex, dotted and over-long prefixes, and absent names', () => {
    expect(
      kthxLabels(
        [
          'shop-web.apps.example.test',
          'notkthx.example.test',
          ZONE,
          `a.b.${ZONE}`,
          `${'x'.repeat(64)}.${ZONE}`,
          '',
          undefined,
        ],
        ZONE,
      ),
    ).toEqual([]);
  });

  test('a 63-character label is still one kthx can serve', () => {
    const longest = 'x'.repeat(63);
    expect(kthxLabels([`${longest}.${ZONE}`], ZONE)).toEqual([longest]);
  });
});

describe('kthxNamesOf', () => {
  const zones: DnsZones = [
    { name: 'apps.example.test', reaches: ['private'] },
    { name: ZONE, reaches: ['private', 'public'] },
  ];

  test('takes canonical and vanity names from every placement in the zone', () => {
    expect(
      kthxNamesOf(
        'shop',
        [
          { component: 'web', reach: 'public', adapter: 'kubernetes' },
          { component: 'api', reach: 'public', adapter: 'kubernetes' },
          // The platform names its own, so only the vanity name is minted.
          { component: 'docs', reach: 'public', adapter: 'vercel' },
          { component: 'cron', reach: 'none', adapter: 'kubernetes' },
        ],
        zones,
        null,
        'shop',
        ZONE,
      ),
    ).toEqual(['shop', 'shop-api', 'shop-web']);
  });

  test('an unpinned App falls through into the zone that serves its reach', () => {
    expect(
      kthxNamesOf(
        'shop',
        [{ component: 'web', reach: 'public', adapter: 'kubernetes' }],
        zones,
        null,
        null,
        ZONE,
      ),
    ).toEqual(['shop-web']);
  });

  test('a pin outside the zone mints nothing there', () => {
    expect(
      kthxNamesOf(
        'shop',
        [{ component: 'web', reach: 'private', adapter: 'kubernetes' }],
        zones,
        'apps.example.test',
        'shop',
        ZONE,
      ),
    ).toEqual([]);
  });

  test('the apex vanity is left to the reserved-hostname rule', () => {
    expect(
      kthxNamesOf(
        'shop',
        [{ component: 'web', reach: 'public', adapter: 'vercel' }],
        zones,
        ZONE,
        '@',
        ZONE,
      ),
    ).toEqual([]);
  });
});
