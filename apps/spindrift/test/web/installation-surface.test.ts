// Drives the browser's command routes, session check included, and edits the
// document through `forms/document.ts` as the form does.
import { describe, expect, test } from 'bun:test';
import type { CommandContext, Principal } from '../../src/commands/types.ts';
import type {
  AuthoredManifest,
  InstallationManifest,
} from '../../src/config/manifest.schema.ts';
import { DEFAULT_PLACEHOLDER_MANIFEST } from '../../src/config/manifest.ts';
import {
  currentStoredManifest,
  loadStoredManifest,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import { installation } from '../../src/db/schema.ts';
import { targetLabel } from '../../src/domain/target.ts';
import {
  commandRoutes,
  type DispatchDeps,
  pathFor,
} from '../../src/web/dispatch.ts';
import { valueAt, withValueAt } from '../../src/web/forms/document.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
// `fixture` is the authored document; `resolved` adds the deployment's
// federation, as a context carries it.
const fixture = await authoredFixture();
const resolved = await fixtureManifest();

const OPERATOR: Principal = {
  id: crypto.randomUUID(),
  displayName: 'Operator',
  kind: 'human',
};

const FROZEN = new Date('2024-06-01T00:00:00.000Z');

// Resolved per dispatch, as `serve.ts` does, so a read after a write sees the row.
async function context(): Promise<CommandContext> {
  const stored = await currentStoredManifest(database().db);
  return {
    principal: OPERATOR,
    clock: { now: () => FROZEN },
    db: database().db,
    manifest: stored ?? resolved,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => null,
      repository: () => null,
      supplyChain: () => {
        throw new Error('configuring an installation reached the supply chain');
      },
    } as unknown as CommandContext['adapters'],
  };
}

const authenticated: DispatchDeps = {
  authenticate: async () => ({ kind: 'authenticated', principal: OPERATOR }),
  context,
};

const anonymous: DispatchDeps = {
  authenticate: async () => ({ kind: 'anonymous' }),
  context: () => {
    throw new Error('an unauthenticated request built a request context');
  },
};

async function post(
  deps: DispatchDeps,
  name: Parameters<typeof pathFor>[0],
  body: unknown,
): Promise<Response> {
  const route = commandRoutes(deps)[pathFor(name)];
  if (route === undefined) throw new Error(`${name} has no route`);
  return route(
    new Request(`https://spindrift.example.test${pathFor(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function seed(): Promise<void> {
  await writeStoredManifest(database().db, fixture);
}

// The real loader, so its placeholder arm writes the row a fresh installation boots with.
async function bootUnconfigured(): Promise<void> {
  await loadStoredManifest(database().db);
}

async function readInstallation(): Promise<{
  manifest: AuthoredManifest;
  configured: boolean;
}> {
  const response = await post(authenticated, 'getInstallationManifest', {});
  const body = (await response.json()) as {
    value: { manifest: AuthoredManifest; configured: boolean };
  };
  return body.value;
}

async function storedManifest(): Promise<AuthoredManifest | undefined> {
  const [row] = await database().db.select().from(installation);
  return row?.manifest;
}

describe('reading this installation from the browser', () => {
  test('answers the stored document, whole', async () => {
    await seed();
    const response = await post(authenticated, 'getInstallationManifest', {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      value: { manifest: AuthoredManifest };
    };
    expect(body.ok).toBe(true);
    // Whole, because `configureInstallation` takes the whole document.
    const stored = await storedManifest();
    expect(stored).toBeDefined();
    // Authored, not resolved: the strict schema refuses the resolved keys, and
    // the form validates before it dispatches.
    expect(body.value.manifest).toEqual(stored as AuthoredManifest);
  });

  test('is refused without a session', async () => {
    await seed();
    const response = await post(anonymous, 'getInstallationManifest', {});
    expect(response.status).toBe(401);
  });
});

describe('whether anybody has configured this installation', () => {
  test('a boot with nothing declared is unconfigured, and says so', async () => {
    await bootUnconfigured();
    const { manifest, configured } = await readInstallation();
    expect(configured).toBe(false);
    expect(manifest).toEqual(DEFAULT_PLACEHOLDER_MANIFEST);
  });

  test('a declaration configured this installation, so onboarding never runs', async () => {
    await seed();
    expect((await readInstallation()).configured).toBe(true);
  });

  test('onboarding’s own write is what ends it', async () => {
    await bootUnconfigured();
    const { manifest } = await readInstallation();
    const named = withValueAt(
      manifest,
      ['installation', 'name'],
      'named-by-onboarding',
    );

    const saved = await post(authenticated, 'configureInstallation', {
      manifest: named,
    });
    expect(saved.status).toBe(200);
    expect((await readInstallation()).configured).toBe(true);
  });
});

describe('configuring this installation from the browser', () => {
  test('is refused without a session, and writes nothing', async () => {
    await seed();
    const before = await storedManifest();
    const response = await post(anonymous, 'configureInstallation', {
      manifest: fixture,
    });
    expect(response.status).toBe(401);
    expect(await storedManifest()).toEqual(before);
  });

  test('writes a value that no declaration can reach', async () => {
    await seed();
    const read = await post(authenticated, 'getInstallationManifest', {});
    const { value } = (await read.json()) as {
      value: { manifest: InstallationManifest };
    };

    const edited = withValueAt(
      value.manifest,
      ['build', 'zeroConfigFrontend'],
      'registry.example.test/zero-config:corrected',
    );

    const saved = await post(authenticated, 'configureInstallation', {
      manifest: edited,
    });
    expect(saved.status).toBe(200);
    expect((await storedManifest())?.build.zeroConfigFrontend).toBe(
      'registry.example.test/zero-config:corrected',
    );
  });

  test('a configured installation reads back what it just wrote', async () => {
    await seed();
    const edited = withValueAt(
      fixture,
      ['supplyChain', 'registry'],
      'registry.example.test/second',
    );
    await post(authenticated, 'configureInstallation', { manifest: edited });

    const read = await post(authenticated, 'getInstallationManifest', {});
    const { value } = (await read.json()) as {
      value: { manifest: InstallationManifest };
    };
    // A bare string reads back as a one-element list.
    expect(valueAt(value.manifest, ['supplyChain', 'registry'])).toEqual([
      'registry.example.test/second',
    ]);
  });

  test('reconciles the Targets the written document declares', async () => {
    // Reconciliation runs inside the manifest write's transaction.
    await seed();
    // Every existing vessel's surfaces are taken, so a new Target needs a new vessel.
    const declaredVessels = [
      ...fixture.vessels,
      { name: 'spare', kind: 'cluster' as const },
    ];
    const declaredTargets = [
      ...fixture.targets,
      { vessel: 'spare', adapter: 'kubernetes' as const },
    ];
    const edited = withValueAt(
      withValueAt(fixture, ['vessels'], declaredVessels),
      ['targets'],
      declaredTargets,
    );

    const saved = await post(authenticated, 'configureInstallation', {
      manifest: edited,
    });
    expect(saved.status).toBe(200);

    const rows = await database().db.query.targets.findMany({
      with: { vessel: true },
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map((row) =>
        targetLabel({ vessel: row.vessel.name, adapter: row.adapter }),
      ),
    ).toEqual(declaredTargets.map((target) => targetLabel(target)));
    expect(rows.some((row) => row.vessel.name === 'spare')).toBe(true);
  });

  test('an invalid document is a 422 naming every offending key', async () => {
    await seed();
    const before = await storedManifest();
    const broken = withValueAt(
      withValueAt(fixture, ['installation'], ''),
      ['dns', 'zones', 0, 'name'],
      '',
    );

    const response = await post(authenticated, 'configureInstallation', {
      manifest: broken,
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      failure: { code: string; message: string };
    };
    expect(body.failure.code).toBe('INVALID_INPUT');
    expect(body.failure.message).toContain('zones.0.name');
    expect(await storedManifest()).toEqual(before);
  });
});
