/**
 * Ticket 32 slice 1's two acceptance criteria, over the surface an operator
 * actually reaches.
 *
 * `test/commands/installation-configure.test.ts` already proves the command.
 * What it cannot prove is the sentence the ticket is written in — "onboarding
 * writes the installation row **through a session-authenticated command**, and
 * Target reconciliation runs on that write" — because a command called directly
 * from a test has no session and no route. So this file drives the browser's
 * own route table: `commandRoutes` is what `Bun.serve` is handed, `pathFor` is
 * the path the typed client posts to, and the request goes through the same
 * authentication check every other command does.
 *
 * The document is edited with `forms/document.ts` — the module the form edits
 * through — rather than by spreading an object here, so what is submitted is
 * what the screen would submit.
 *
 * The context resolves the manifest per dispatch, exactly as `serve.ts` does,
 * because that is what makes the read-after-write in these tests mean anything:
 * a process-lifetime copy would answer a `getInstallationManifest` with what
 * the row held at boot.
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext, Principal } from '../../src/commands/types.ts';
import type {
  AuthoredManifest,
  InstallationManifest,
} from '../../src/config/manifest.schema.ts';
import { resolveManifest } from '../../src/config/manifest.ts';
import {
  currentStoredManifest,
  loadStoredManifest,
} from '../../src/config/manifest-store.ts';
import { installation } from '../../src/db/schema.ts';
import {
  commandRoutes,
  type DispatchDeps,
  pathFor,
} from '../../src/web/dispatch.ts';
import { valueAt, withValueAt } from '../../src/web/forms/document.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
// The document an operator writes. `resolved` is the same installation with
// the deployment's federation joined on, which is what a context carries.
const fixture = await authoredFixture();
const resolved = await fixtureManifest();

const OPERATOR: Principal = {
  id: crypto.randomUUID(),
  displayName: 'Operator',
};

const FROZEN = new Date('2024-06-01T00:00:00.000Z');

/** A context whose manifest is the row, resolved per dispatch. */
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

/** Post to a command's own route, the way `client.ts` does. */
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
  await loadStoredManifest(database().db, {
    SPINDRIFT_MANIFEST: JSON.stringify(fixture),
  });
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
    // Whole, because `configureInstallation` takes the whole document: a read
    // that returned a subset would make the form delete every key it did not
    // ask for.
    const stored = await storedManifest();
    expect(stored).toBeDefined();
    // And *authored*, which is the row exactly. This assertion used to compare
    // against `resolveManifest(stored)`, on the reasoning that anything else
    // would prove the read had never resolved. That reasoning is what broke
    // this surface: a reader is handed the resolved document, the schema is
    // `.strict()`, and the form validates client-side before it dispatches — so
    // answering the resolved shape made the screen refuse its own round trip
    // with `cloud: Unrecognized key: "federation"` on a field it never
    // rendered. The read half answers what the write half accepts.
    expect(body.value.manifest).toEqual(stored as AuthoredManifest);
  });

  test('is refused without a session', async () => {
    await seed();
    const response = await post(anonymous, 'getInstallationManifest', {});
    expect(response.status).toBe(401);
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
    // The act ticket 29's second item has no other path to: a declaration only
    // seeds an empty row, and an installation with a row keeps it. The edit is
    // made through the form's own document module.
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
    // Criterion 2. The value has to survive the round trip through the row,
    // not just through this process — `context.manifest` is resolved per
    // dispatch for exactly that reason.
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
    // A list, from a document that wrote a bare string: an installation whose
    // Targets cannot share a registry names several, and one is the same
    // document as a one-element list (ticket 39). Nothing stored has to be
    // rewritten to keep parsing.
    expect(valueAt(value.manifest, ['supplyChain', 'registry'])).toEqual([
      'registry.example.test/second',
    ]);
  });

  test('reconciles the Targets the written document declares', async () => {
    // Criterion 1's second half, and the one a form is most likely to break:
    // reconciliation runs inside the write's transaction, so a surface that
    // reached a different writer would leave a Target declared in the document
    // and absent from the table.
    await seed();
    const declared = [
      ...fixture.targets,
      { name: 'spare', adapter: 'kubernetes' },
    ];
    const edited = withValueAt(fixture, ['targets'], declared);

    const saved = await post(authenticated, 'configureInstallation', {
      manifest: edited,
    });
    expect(saved.status).toBe(200);

    const rows = await database().db.query.targets.findMany({
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(rows.map((row) => row.name)).toEqual(
      declared.map((target) => target.name),
    );
    // A Target nobody named through the product exists because the manifest
    // said so, which is the whole reason the write and the reconcile are one
    // transaction.
    expect(rows.some((row) => row.name === 'spare')).toBe(true);
  });

  test('an invalid document is a 422 naming every offending key', async () => {
    await seed();
    const before = await storedManifest();
    const broken = withValueAt(
      withValueAt(fixture, ['installation'], ''),
      ['dns', 'apexZone'],
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
    expect(body.failure.message).toContain('apexZone');
    expect(await storedManifest()).toEqual(before);
  });

  test('a document this installation cannot take is a 409, not a field error', async () => {
    // The distinction the screen renders. 409 rather than 422 because the
    // request is well formed and the caller has nothing to fix in it — §3's
    // disabled-with-reasons grammar, over HTTP.
    await seed();
    const swapped = withValueAt(
      fixture,
      ['targets'],
      [
        { name: 'cluster', adapter: 'kubernetes' },
        { name: 'cloud-cloudrun', adapter: 'kubernetes' },
      ],
    );

    const response = await post(authenticated, 'configureInstallation', {
      manifest: swapped,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { failure: { code: string } };
    expect(body.failure.code).toBe('NOT_DEPLOYABLE');
  });
});
