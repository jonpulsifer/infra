import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  type BootCatalogInput,
  getOriginInfo,
  loadBootCatalog,
  parseBootCatalog,
} from '../lib/catalog';

const validCatalog = (): BootCatalogInput => ({
  serverOrigin: 'http://10.2.0.11/spore',
  allowUnknownHosts: false,
  defaultProfile: 'local',
  profiles: {
    local: {
      name: 'Local boot',
      content: '#!ipxe\necho {{hostname}} via {{base_url}}\nexit\n',
    },
    k8s: {
      name: 'Kubernetes node',
      content:
        '#!ipxe\nchain {{base_url}}/api/scripts/k8s/netboot.ipxe?mac={{mac}}\n',
    },
  },
  scripts: {
    'k8s/netboot.ipxe': {
      description: 'Nix-owned netboot chain',
      content: '#!ipxe\nchain http://{{server_ip}}/netboot/netboot.ipxe\n',
    },
  },
  hosts: {
    'AA-BB-CC-DD-EE-FF': { hostname: 'nuc', profile: 'k8s' },
  },
});

describe('boot catalog', () => {
  test('parses, normalizes, and freezes a valid catalog', () => {
    const catalog = parseBootCatalog(validCatalog());

    expect(catalog.hosts['aa:bb:cc:dd:ee:ff']).toEqual({
      hostname: 'nuc',
      profile: 'k8s',
    });
    expect(catalog.serverOrigin).toBe('http://10.2.0.11/spore');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.hosts)).toBe(true);
    expect(Object.isFrozen(catalog.profiles.local)).toBe(true);
  });

  test('keeps the committed development catalog valid', () => {
    const path = fileURLToPath(
      new URL('../catalog.example.json', import.meta.url),
    );
    expect(loadBootCatalog(path).profiles.local?.name).toBe(
      'Local development',
    );
  });

  test.each([
    'not-a-url',
    'ftp://10.2.0.11/spore',
    'http://user:secret@10.2.0.11/spore',
    'http://10.2.0.11/spore/',
    'http://10.2.0.11/spore?override=true',
    'http://10.2.0.11/spore#fragment',
  ])('rejects malformed or unsafe origin %s', (serverOrigin) => {
    expect(() => parseBootCatalog({ ...validCatalog(), serverOrigin })).toThrow(
      /serverOrigin/,
    );
  });

  test('rejects dangling host and default profile references', () => {
    const danglingHost = validCatalog();
    danglingHost.hosts['AA-BB-CC-DD-EE-FF'].profile = 'missing';
    expect(() => parseBootCatalog(danglingHost)).toThrow(/missing profile/);

    expect(() =>
      parseBootCatalog({ ...validCatalog(), defaultProfile: 'missing' }),
    ).toThrow(/defaultProfile/);
  });

  test('rejects malformed and colliding MAC addresses', () => {
    expect(() =>
      parseBootCatalog({
        ...validCatalog(),
        hosts: { nope: { hostname: 'broken' } },
      }),
    ).toThrow(/MAC/);

    const collision = validCatalog();
    collision.hosts['aa:bb:cc:dd:ee:ff'] = { hostname: 'duplicate' };
    expect(() => parseBootCatalog(collision)).toThrow(/duplicate MAC/);
  });

  test.each([
    '../secret.ipxe',
    '/absolute.ipxe',
    'k8s/../secret.ipxe',
    './relative.ipxe',
    'k8s\\netboot.ipxe',
    'k8s//netboot.ipxe',
  ])('rejects unsafe script path %s', (path) => {
    expect(() =>
      parseBootCatalog({
        ...validCatalog(),
        scripts: { [path]: { content: '#!ipxe\nexit\n' } },
      }),
    ).toThrow(/script path/);
  });

  test('requires iPXE profile and script content', () => {
    expect(() =>
      parseBootCatalog({
        ...validCatalog(),
        profiles: { local: { name: 'Local', content: 'echo nope' } },
      }),
    ).toThrow(/#!ipxe/);
    expect(() =>
      parseBootCatalog({
        ...validCatalog(),
        scripts: { test: { content: '\n#!ipxe\nexit' } },
      }),
    ).toThrow(/#!ipxe/);
  });

  test('rejects unknown keys instead of silently ignoring catalog typos', () => {
    expect(() =>
      parseBootCatalog({ ...validCatalog(), allowUnkownHosts: true }),
    ).toThrow(/Unrecognized key/);
  });

  test('derives canonical origin facts with URL semantics', () => {
    expect(getOriginInfo(parseBootCatalog(validCatalog()))).toEqual({
      baseUrl: 'http://10.2.0.11/spore',
      serverIp: '10.2.0.11',
    });

    const ipv6 = validCatalog();
    ipv6.serverOrigin = 'https://[2001:db8::11]:8443/spore';
    expect(getOriginInfo(parseBootCatalog(ipv6))).toEqual({
      baseUrl: 'https://[2001:db8::11]:8443/spore',
      serverIp: '[2001:db8::11]',
    });
  });
});
