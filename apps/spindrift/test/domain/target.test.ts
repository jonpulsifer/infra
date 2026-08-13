/**
 * `deployTargetOf` — the composition that hands an adapter one flat object.
 *
 * The function is the only place a vessel's boundary facts cross into what an
 * adapter's `discover` reads, so a hole here is invisible to every adapter
 * test: those build their connections by hand. The claims worth pinning are
 * the network's — it is optional, and both halves of optional have a meaning
 * (§20: absence is a capability the Target lacks, not an unmet prerequisite).
 */
import { describe, expect, test } from 'bun:test';
import { deployTargetOf, type VesselRef } from '../../src/domain/target.ts';

function vessel(overrides: Partial<VesselRef> = {}): VesselRef {
  return {
    name: 'bluenose',
    location: { kind: 'gcp-project', project: 'bluenose' },
    servedHosts: null,
    reachableRegistries: null,
    ...overrides,
  };
}

const SURFACE = {
  adapter: 'cloudrun',
  connection: {
    adapter: 'cloudrun',
    region: 'northamerica-northeast1',
    endpoint: 'https://run.example.test',
  },
} as const;

describe('a gcp-project vessel and its network fact', () => {
  test('a vessel with no network composes a connection with none', () => {
    const ref = deployTargetOf(SURFACE, vessel());
    expect(ref.vessel).toBe('bluenose');
    expect(ref.adapter).toBe('cloudrun');
    expect(ref.connection).not.toHaveProperty('network');
    // The address itself still crosses — the network is a rider, never the
    // address.
    expect(ref.connection).toHaveProperty('project', 'bluenose');
  });

  test('a vessel network crosses the seam unchanged', () => {
    const network = { name: 'spindrift-vessel', region: 'somewhere' };
    const ref = deployTargetOf(
      SURFACE,
      vessel({
        location: { kind: 'gcp-project', project: 'bluenose', network },
      }),
    );
    expect(ref.connection).toHaveProperty('network', network);
    expect(ref.connection).toHaveProperty('project', 'bluenose');
  });
});
