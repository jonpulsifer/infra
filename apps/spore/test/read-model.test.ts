import { describe, expect, test } from 'bun:test';
import { parseBootCatalog } from '../lib/catalog';
import { buildReadModel } from '../lib/read-model';

const catalog = parseBootCatalog({
  serverOrigin: 'http://10.2.0.11/spore',
  allowUnknownHosts: false,
  defaultProfile: 'default',
  profiles: {
    default: {
      name: 'Default menu',
      content: '#!ipxe\nexit',
    },
    k8s: {
      name: 'Kubernetes node',
      content: '#!ipxe\nchain {{base_url}}/api/scripts/k8s/netboot.ipxe',
    },
  },
  scripts: {
    'k8s/netboot.ipxe': {
      content: '#!ipxe\nexit',
    },
  },
  hosts: {
    '00:00:00:00:00:02': { hostname: 'zeta', profile: 'k8s' },
    '00:00:00:00:00:01': { hostname: 'alpha' },
  },
});

describe('Spore read model', () => {
  test('joins catalog hosts and observations without hiding configured hosts', () => {
    const model = buildReadModel(catalog, [
      {
        macAddress: '00:00:00:00:00:02',
        firstSeen: '2026-07-19T12:00:00.000Z',
        lastSeen: '2026-07-19T12:05:00.000Z',
        bootCount: 2,
        lastOutcome: 'profile',
        lastProfile: 'k8s',
      },
    ]);

    expect(model.hosts).toHaveLength(2);
    expect(model.hosts[0]).toMatchObject({
      macAddress: '00:00:00:00:00:01',
      hostname: 'alpha',
      configured: true,
      profileId: 'default',
      effectiveOutcome: 'default-profile',
      firstSeen: null,
      lastSeen: null,
      bootCount: 0,
    });
    expect(model.hosts[1]).toMatchObject({
      macAddress: '00:00:00:00:00:02',
      hostname: 'zeta',
      configured: true,
      profileId: 'k8s',
      effectiveOutcome: 'profile',
      bootCount: 2,
      lastOutcome: 'profile',
    });
    expect(model.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'default', hostCount: 1 }),
        expect.objectContaining({ id: 'k8s', hostCount: 1 }),
      ]),
    );
  });

  test('keeps unknown observations after configured hosts in stable order', () => {
    const model = buildReadModel(catalog, [
      {
        macAddress: '00:00:00:00:00:04',
        firstSeen: '2026-07-19T12:00:00.000Z',
        lastSeen: '2026-07-19T12:00:00.000Z',
        bootCount: 1,
        lastOutcome: 'unknown-denied',
        lastProfile: null,
      },
      {
        macAddress: '00:00:00:00:00:03',
        firstSeen: '2026-07-19T12:00:00.000Z',
        lastSeen: '2026-07-19T12:00:00.000Z',
        bootCount: 1,
        lastOutcome: 'unknown-denied',
        lastProfile: null,
      },
    ]);

    expect(model.hosts.map((host) => host.macAddress)).toEqual([
      '00:00:00:00:00:01',
      '00:00:00:00:00:02',
      '00:00:00:00:00:03',
      '00:00:00:00:00:04',
    ]);
    expect(model.hosts[2]).toMatchObject({
      hostname: null,
      profileId: null,
      effectiveOutcome: 'unknown-denied',
      configured: false,
      lastOutcome: 'unknown-denied',
    });
  });

  test('projects the effective policy for unknown hosts', () => {
    const unknownObservation = {
      macAddress: '00:00:00:00:00:03',
      firstSeen: '2026-07-19T12:00:00.000Z',
      lastSeen: '2026-07-19T12:00:00.000Z',
      bootCount: 1,
      lastOutcome: 'unknown-allowed' as const,
      lastProfile: 'default',
    };
    const allowedCatalog = parseBootCatalog({
      serverOrigin: catalog.serverOrigin,
      allowUnknownHosts: true,
      defaultProfile: catalog.defaultProfile,
      profiles: catalog.profiles,
      scripts: catalog.scripts,
      hosts: catalog.hosts,
    });

    expect(
      buildReadModel(allowedCatalog, [unknownObservation]).hosts[2],
    ).toMatchObject({
      profileId: 'default',
      effectiveOutcome: 'unknown-allowed',
    });

    const noDefaultCatalog = parseBootCatalog({
      serverOrigin: catalog.serverOrigin,
      allowUnknownHosts: true,
      defaultProfile: null,
      profiles: catalog.profiles,
      scripts: catalog.scripts,
      hosts: catalog.hosts,
    });
    expect(
      buildReadModel(noDefaultCatalog, [unknownObservation]).hosts[2],
    ).toMatchObject({
      profileId: null,
      effectiveOutcome: 'missing-profile',
    });
  });
});
