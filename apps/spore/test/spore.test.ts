import { describe, expect, test } from 'bun:test';
import { parseBootCatalog } from '../lib/catalog';
import { createSpore } from '../lib/spore';

const catalog = parseBootCatalog({
  serverOrigin: 'http://10.2.0.11/spore',
  allowUnknownHosts: true,
  defaultProfile: 'local',
  profiles: {
    local: {
      name: 'Local',
      content: '#!ipxe\necho boot {{mac}}\nexit\n',
    },
  },
  scripts: {},
  hosts: {},
});

describe('Spore composition', () => {
  test('keeps Git-owned boot decisions available when SQLite cannot open', () => {
    const errors: unknown[] = [];
    const spore = createSpore({
      loadCatalog: () => catalog,
      createObservations: () => {
        throw new Error('database is corrupt');
      },
      onObservationError: (error) => errors.push(error),
    });

    expect(spore.boot.decideBoot('02:00:00:00:00:01')).toMatchObject({
      status: 200,
      outcome: 'unknown-allowed',
    });
    expect(spore.observations.listObservations()).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(() => spore.health()).toThrow(/database is unavailable/);
  });
});
