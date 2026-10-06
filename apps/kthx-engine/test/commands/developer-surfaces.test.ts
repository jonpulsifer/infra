/**
 * Where a developer points a tool, read from the deployment's facts. The
 * command reaches no database and calls kthx for nothing.
 */
import { describe, expect, test } from 'bun:test';
import { getDeveloperSurfaces } from '../../src/commands/developer/surfaces.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import {
  HOSTNAME_VAR,
  PUBLIC_HOSTNAME_VAR,
  UNSERVED_HOSTNAME,
} from '../../src/config/manifest.ts';
import { unreachableContext } from '../harness/context.ts';
import { FakeKthx, KTHX_ORIGIN, KTHX_ZONE } from '../harness/fakes/kthx.ts';
import { FIXTURE_DEPLOYMENT_ENV } from '../harness/installation.ts';

const base = await unreachableContext();

function context(
  overrides: {
    readonly kthx?: FakeKthx | null;
    readonly hostname?: string;
    readonly publicHostname?: string | null;
  } = {},
): CommandContext {
  const kthx = overrides.kthx === undefined ? new FakeKthx() : overrides.kthx;
  return {
    ...base,
    manifest: {
      ...base.manifest,
      controlPlane: {
        ...base.manifest.controlPlane,
        ...(overrides.hostname === undefined
          ? {}
          : { hostname: overrides.hostname }),
        ...(overrides.publicHostname === undefined
          ? {}
          : { publicHostname: overrides.publicHostname }),
      },
    },
    adapters: { ...base.adapters, kthx: () => kthx },
  };
}

const PRIVATE = `https://${FIXTURE_DEPLOYMENT_ENV[HOSTNAME_VAR]}/mcp`;
const PUBLIC = `https://${FIXTURE_DEPLOYMENT_ENV[PUBLIC_HOSTNAME_VAR]}/mcp`;

describe('getDeveloperSurfaces', () => {
  test('both MCP addresses and kthx come from the deployment', async () => {
    expect(await getDeveloperSurfaces({}, context())).toEqual({
      ok: true,
      value: {
        adminMcp: { private: PRIVATE, public: PUBLIC },
        kthx: { origin: KTHX_ORIGIN, zone: KTHX_ZONE },
      },
    });
  });

  test('the stand-in hostname is no address', async () => {
    const read = await getDeveloperSurfaces(
      {},
      context({ hostname: UNSERVED_HOSTNAME }),
    );
    if (!read.ok) throw new Error('refused');
    expect(read.value.adminMcp).toEqual({ private: null, public: PUBLIC });
  });

  test('no public host is no public address', async () => {
    const read = await getDeveloperSurfaces(
      {},
      context({ publicHostname: null }),
    );
    if (!read.ok) throw new Error('refused');
    expect(read.value.adminMcp).toEqual({ private: PRIVATE, public: null });
  });

  test('an installation with no kthx says so, with no fallback', async () => {
    const read = await getDeveloperSurfaces({}, context({ kthx: null }));
    if (!read.ok) throw new Error('refused');
    expect(read.value.kthx).toBeNull();

    const without = await getDeveloperSurfaces(
      {},
      { ...context(), adapters: base.adapters },
    );
    if (!without.ok) throw new Error('refused');
    expect(without.value.kthx).toBeNull();
  });

  test('it reads only: kthx is never called', async () => {
    const kthx = new FakeKthx();
    await getDeveloperSurfaces({}, context({ kthx }));
    expect(kthx.calls).toEqual([]);
  });

  test('the registry dispatches it and refuses any argument', async () => {
    expect((await dispatch('getDeveloperSurfaces', {}, context())).ok).toBe(
      true,
    );
    const refused = await dispatch(
      'getDeveloperSurfaces',
      { zone: 'elsewhere' },
      context(),
    );
    expect(refused.ok ? null : refused.failure.code).toBe('INVALID_INPUT');
  });
});
