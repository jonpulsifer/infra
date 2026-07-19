import { describe, expect, test } from 'bun:test';
import {
  type BootRouteDecision,
  createBootGet,
} from '../app/api/boot/[mac]/route';
import { createHealthGet } from '../app/api/health/route';
import { createNativeBootGet } from '../app/api/native-boot/[target]/[artifact]/route';
import { createScriptGet } from '../app/api/scripts/[...path]/route';

describe('boot HTTP adapter', () => {
  test('passes the complete MAC parameter and maps a successful decision', async () => {
    const received: string[] = [];
    const GET = createBootGet(() => ({
      decideBoot(macAddress: string): BootRouteDecision {
        received.push(macAddress);
        return { status: 200, content: '#!ipxe\necho ready\n' };
      },
    }));

    const response = await GET(new Request('http://untrusted.example/boot'), {
      params: Promise.resolve({ mac: 'AA-BB-CC-DD-EE-FF' }),
    });

    expect(received).toEqual(['AA-BB-CC-DD-EE-FF']);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('#!ipxe\necho ready\n');
  });

  test('preserves an invalid-MAC 400 decision', async () => {
    const GET = createBootGet(() => ({
      decideBoot: () => ({
        status: 400,
        content: '#!ipxe\necho invalid\nexit\n',
      }),
    }));
    const response = await GET(new Request('http://localhost/boot'), {
      params: Promise.resolve({ mac: 'invalid' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('script HTTP adapter', () => {
  test('forwards joined path and optional query MAC', async () => {
    const received: Array<[string, string | null]> = [];
    const GET = createScriptGet(() => ({
      renderScript(path: string, macAddress?: string | null) {
        received.push([path, macAddress ?? null]);
        return { status: 200, content: '#!ipxe\necho script\n' };
      },
    }));

    const response = await GET(
      new Request(
        'http://untrusted.example/spore/api/scripts/k8s/netboot.ipxe?mac=aa-bb-cc-dd-ee-ff',
      ),
      { params: Promise.resolve({ path: ['k8s', 'netboot.ipxe'] }) },
    );

    expect(received).toEqual([['k8s/netboot.ipxe', 'aa-bb-cc-dd-ee-ff']]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('preserves missing-script 404 responses', async () => {
    const GET = createScriptGet(() => ({
      renderScript: () => ({
        status: 404,
        content: '#!ipxe\necho missing\nexit\n',
      }),
    }));
    const response = await GET(new Request('http://localhost/missing'), {
      params: Promise.resolve({ path: ['missing.ipxe'] }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('health HTTP adapter', () => {
  test('reports ok only after catalog and database health succeeds', async () => {
    let checked = false;
    const GET = createHealthGet(() => ({
      health() {
        checked = true;
      },
    }));
    const response = await GET();
    expect(checked).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('reports failure without leaking the health exception', async () => {
    const GET = createHealthGet(() => ({
      health() {
        throw new Error('database path and catalog secret-ish content');
      },
    }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('failure\n');
  });
});

describe('native boot HTTP adapter', () => {
  test('hands an allowed artifact to the internal nginx location', async () => {
    const received: Array<[string, string, string | null]> = [];
    const GET = createNativeBootGet(() => ({
      resolveNativeBoot(
        target: string,
        artifact: string,
        digest?: string | null,
      ) {
        received.push([target, artifact, digest ?? null]);
        return {
          status: 200 as const,
          outcome: 'native-boot' as const,
          internalPath: '/_spore-native-boot/rackpi5/boot.img',
        };
      },
    }));

    const response = await GET(
      new Request('http://untrusted.example/native-boot'),
      {
        params: Promise.resolve({ target: 'rackpi5', artifact: 'boot.img' }),
      },
    );

    expect(received).toEqual([['rackpi5', 'boot.img', null]]);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-redirect')).toBe(
      '/_spore-native-boot/rackpi5/boot.img',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('passes a pinned squashfs digest to the policy service', async () => {
    const digest = 'b'.repeat(64);
    const received: Array<string | null> = [];
    const GET = createNativeBootGet(() => ({
      resolveNativeBoot(_target, _artifact, sha256) {
        received.push(sha256 ?? null);
        return {
          status: 200 as const,
          outcome: 'native-boot' as const,
          internalPath: `/_spore-native-boot/stores/${digest}.squashfs`,
        };
      },
    }));

    const response = await GET(
      new Request(`http://localhost/native-boot?sha256=${digest}`),
      {
        params: Promise.resolve({
          target: 'rackpi5',
          artifact: 'nix-store.squashfs',
        }),
      },
    );

    expect(received).toEqual([digest]);
    expect(response.headers.get('x-accel-redirect')).toBe(
      `/_spore-native-boot/stores/${digest}.squashfs`,
    );
  });

  test('does not emit an internal path for a denied artifact', async () => {
    const GET = createNativeBootGet(() => ({
      resolveNativeBoot: () => ({
        status: 404 as const,
        outcome: 'native-boot-not-found' as const,
        internalPath: null,
      }),
    }));
    const response = await GET(new Request('http://localhost/native-boot'), {
      params: Promise.resolve({ target: 'rackpi5', artifact: '../boot.img' }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.has('x-accel-redirect')).toBe(false);
  });
});
