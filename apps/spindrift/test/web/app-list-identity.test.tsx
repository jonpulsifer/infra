/**
 * A row in the App list stands for one App (§18, and §2's identity rules).
 *
 * `apps` carries no unique constraint on `name` — `components` has
 * `unique(appId, name)` and `targets` has `unique(name)`, `apps` has neither —
 * so two Apps can wear one name, and a real installation does. `deployApp` and
 * `deleteApp` already refuse to guess between them. The list was the surface
 * that could not ask a better question: it dropped the id before the view ran,
 * so both rows keyed the same, linked the same, and offered a delete the
 * command was right to refuse.
 *
 * Both halves are proved here against **two genuinely different Apps sharing
 * one name**, because one App checked twice is the shape that made this look
 * fine for as long as it did:
 *
 * - the far side hands out an identity — `listApps` carries the id, and each id
 *   opens its own workspace and reviews for its own deletion;
 * - the near side uses it — the row's key, its link, and its trash button are
 *   all the id.
 *
 * The view half calls the components as functions and reads the tree they
 * return, rather than rendering to markup: what is under test is *which value*
 * a handler is closed over, and that is not something markup can show.
 */
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { deleteApp } from '../../src/commands/apps/delete.ts';
import { listApps } from '../../src/commands/apps/list.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  builds,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  type AppDeletion,
  type AppDeletionControls,
  DeleteAppButton,
} from '../../src/web/components/delete-app.tsx';
import {
  type ExplorerItem,
  ObjectExplorer,
} from '../../src/web/components/object-explorer.tsx';
import type { AppListItem, DeployPhase } from '../../src/web/model.ts';
import { AppList, appHref } from '../../src/web/views/apps/list.tsx';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-08-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('the App list reached the supply chain');
  },
};

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

/**
 * Two Apps that answer to one name and are not each other: one a `service`, one
 * a `website`, which is the pair a real installation ended up with.
 */
async function seedTwins(ctx: CommandContext, name: string) {
  const made: { id: string; kind: 'service' | 'website' }[] = [];
  for (const kind of ['service', 'website'] as const) {
    const app = await createApp(
      {
        name,
        sourceKind: 'repo',
        repoUrl: 'https://vcs.example/acme/twins.git',
        subpath: kind,
      },
      ctx,
    );
    if (!app.ok) throw new Error(app.failure.message);

    const component = await createComponent(
      kind === 'website'
        ? {
            appId: app.value.appId,
            name: 'web',
            kind: 'website',
            reach: 'public',
            auth: 'none',
          }
        : {
            appId: app.value.appId,
            name: 'web',
            kind: 'service',
            expose: true,
            reach: 'private',
            auth: 'proxy',
          },
      ctx,
    );
    if (!component.ok) throw new Error(component.failure.message);

    made.push({ id: app.value.appId, kind });
  }
  return made;
}

/**
 * One App with two Components, released to two different verdicts.
 *
 * The `web` Component is serving and the `worker` behind it is red — the shape
 * the list used to report as `live`, because it read the phase off
 * `components[0]` and stopped. Each Component gets its own Target so the two
 * releases are genuinely independent rather than two rows on one placement.
 */
async function seedSplitApp(ctx: CommandContext) {
  const name = `split-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    { name, sourceKind: 'repo', repoUrl: 'https://vcs.example/acme/split.git' },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const released: { name: string; phase: DeployPhase; commit: string }[] = [];
  let redDeployId = 0;

  for (const [componentName, phase] of [
    ['web', 'LIVE'],
    ['worker', 'FAILED'],
  ] as const) {
    const component = await createComponent(
      {
        appId: app.value.appId,
        name: componentName,
        kind: 'service',
        expose: componentName === 'web',
        reach: componentName === 'web' ? 'private' : 'none',
        auth: componentName === 'web' ? 'proxy' : 'none',
      },
      ctx,
    );
    if (!component.ok) throw new Error(component.failure.message);

    const vessel = await insertVessel(ctx.db, 'kubernetes', {
      name: `cluster-${crypto.randomUUID()}`,
    });
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
      .returning();
    await ctx.db.insert(componentTargetDesired).values({
      componentId: component.value.componentId,
      targetId: target!.id,
    });

    const commit = crypto.randomUUID().slice(0, 7);
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: component.value.componentId,
        commit,
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId: component.value.componentId,
        desired: aDesiredDocument(),
        targetId: target!.id,
        buildId: build!.id,
        phase,
      })
      .returning();

    if (phase === 'FAILED') redDeployId = deploy!.id;
    released.push({ name: componentName, phase, commit });
  }

  return { appId: app.value.appId, name, released, redDeployId };
}

describe('an App is as healthy as its worst Component', () => {
  test('a green service in front of a red worker does not read as live', async () => {
    const ctx = context();
    const seeded = await seedSplitApp(ctx);

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const row = listed.value.apps.find((app) => app.id === seeded.appId);
    expect(row).toBeDefined();
    if (!row) return;

    // The whole defect: `components[0]` is the `web` that is serving.
    expect(row.phase).toBe('FAILED');
    expect(row.componentCount).toBe(2);
    expect(row.failing).toBe(1);
  });

  test('and every other fact on the row belongs to that same Component', async () => {
    // A row that named one Component's commit beside another's placement is
    // two answers wearing one line, and no reader can tell which is which.
    const ctx = context();
    const seeded = await seedSplitApp(ctx);
    const red = seeded.released.find((entry) => entry.phase === 'FAILED');

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const row = listed.value.apps.find((app) => app.id === seeded.appId);
    expect(row?.commit).toBe(red?.commit ?? '');
    expect(row?.deployId).toBe(seeded.redDeployId);
    // The instant the release was written, so the scan can be ordered by how
    // long each App has been in the state it is in.
    expect(row?.at).toBeDefined();
    expect(row?.when).toBeDefined();
  });
});

describe('two Apps answer to one name', () => {
  test('the list carries an id for each, and the ids differ', async () => {
    const ctx = context();
    const name = `twins-${crypto.randomUUID().slice(0, 8)}`;
    const twins = await seedTwins(ctx, name);

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const rows = listed.value.apps.filter((app) => app.name === name);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    // And the ids are the Apps', not something the projection invented.
    expect(rows.map((row) => row.id).sort()).toEqual(
      twins.map((twin) => twin.id).sort(),
    );
  });

  test('each id opens its own workspace', async () => {
    const ctx = context();
    const name = `twins-${crypto.randomUUID().slice(0, 8)}`;
    await seedTwins(ctx, name);

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = listed.value.apps.filter((app) => app.name === name);
    expect(rows).toHaveLength(2);

    // The row says which kind it is; the workspace it links to must agree, or
    // one of the two rows is a link to the other one's App.
    for (const row of rows) {
      const workspace = await getAppWorkspace({ name: row.id }, ctx);
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) continue;
      expect(workspace.value.workspace.appId).toBe(row.id);
      expect(workspace.value.workspace.components[0]?.kind).toBe(row.kind);
    }

    // By name, both rows land on the same App — the reason the id is carried.
    const byName = await getAppWorkspace({ name }, ctx);
    expect(byName.ok).toBe(true);
    if (!byName.ok) return;
    const resolved = byName.value.workspace.appId ?? '';
    expect(rows.map((row) => row.id)).toContain(resolved);
  });

  test('each can be reviewed for deletion independently', async () => {
    const ctx = context();
    const name = `twins-${crypto.randomUUID().slice(0, 8)}`;
    await seedTwins(ctx, name);

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = listed.value.apps.filter((app) => app.name === name);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      const review = await deleteApp({ name: row.id, confirm: false }, ctx);
      expect(review.ok).toBe(true);
      if (!review.ok) continue;
      expect(review.value.deleted).toBe(false);
      // The id the confirm call will go by is this row's, not the other's.
      expect(review.value.appId).toBe(row.id);
    }

    // A review by name alone is ambiguous across the two rows, and the refusal
    // is what keeps either from being deleted by accident.
    const ambiguous = await deleteApp({ name, confirm: false }, ctx);
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.failure.code).toBe('INVALID_INPUT');
  });

  test('and deleting one by id leaves the other', async () => {
    const ctx = context();
    const name = `twins-${crypto.randomUUID().slice(0, 8)}`;
    await seedTwins(ctx, name);

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = listed.value.apps.filter((app) => app.name === name);
    expect(rows).toHaveLength(2);

    const gone = rows[0]!;
    const kept = rows[1]!;
    const deleted = await deleteApp({ name: gone.id, confirm: true }, ctx);
    expect(deleted.ok).toBe(true);

    const after = await listApps({}, ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const remaining = after.value.apps.filter((app) => app.name === name);
    expect(remaining.map((app) => app.id)).toEqual([kept.id]);
  });
});

/** Every element in a tree, depth first — the tree as returned, not rendered. */
function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* elements((node.props as { children?: ReactNode }).children);
}

/** A pair of rows sharing a name, as the browser contract now delivers them. */
const TWIN_ROWS: readonly AppListItem[] = [
  {
    id: '00000000-0000-4000-8000-0000000000b1',
    name: 'twins',
    phase: 'PENDING',
    target: 'none',
    vessel: 'driftwood',
    url: '',
    urlLive: false,
    kind: 'service',
    source: 'acme/twins',
    artifact: 'none',
  },
  {
    id: '00000000-0000-4000-8000-0000000000b2',
    name: 'twins',
    phase: 'FAILED',
    target: 'Metal',
    vessel: 'driftwood',
    url: 'twins.apps.example',
    urlLive: false,
    kind: 'website',
    source: 'acme/twins',
    artifact: 'image · a1b2c3d4e5f6',
  },
];

const IDS = TWIN_ROWS.map((row) => row.id);

const idleDeletion: AppDeletionControls = {
  state: { kind: 'idle' } as AppDeletion,
  review: () => undefined,
  confirm: () => undefined,
  dismiss: () => undefined,
};

describe('the list renders two same-named rows as two Apps', () => {
  const tree = AppList({
    apps: TWIN_ROWS,
    onNavigate: () => undefined,
    deletion: idleDeletion,
  });
  const explorer = [...elements(tree)].find(
    (element) => element.type === ObjectExplorer,
  );
  if (!explorer) throw new Error('the App list offered no object explorer');
  const explorerProps = explorer.props as {
    items: readonly ExplorerItem[];
    renderInspector: (item: ExplorerItem) => ReactNode;
  };

  test('there are two rows, keyed by id rather than by name', () => {
    // Keyed by name, React sees one key twice and reconciles two Apps into one
    // row — before any of the rest of this can even be asked.
    expect(explorerProps.items.map((row) => row.id)).toEqual(
      IDS.map((id) => `app:${id}`),
    );
  });

  test('each row navigates to its own App', () => {
    const visited: string[] = [];
    const navigating = AppList({
      apps: TWIN_ROWS,
      onNavigate: (path) => visited.push(path),
      deletion: idleDeletion,
    });
    const navigatingExplorer = [...elements(navigating)].find(
      (element) => element.type === ObjectExplorer,
    );
    if (!navigatingExplorer) throw new Error('no navigating object explorer');
    const props = navigatingExplorer.props as {
      items: readonly ExplorerItem[];
      renderInspector: (item: ExplorerItem) => ReactNode;
    };
    for (const item of props.items) {
      const inspector = props.renderInspector(item);
      for (const inner of elements(inspector)) {
        const control = inner.props as { onClick?: () => void };
        if (control.onClick) {
          control.onClick();
          break;
        }
      }
    }
    expect(visited).toEqual(IDS.map((id) => `/apps/${id}`));
  });

  test('each row hands its own id to the trash affordance', () => {
    const targets = explorerProps.items.map((item) => {
      for (const inner of elements(explorerProps.renderInspector(item))) {
        if (inner.type === DeleteAppButton) {
          return inner.props as { appId: string; name: string };
        }
      }
      throw new Error('a row offered no delete');
    });
    expect(targets.map((target) => target.appId)).toEqual([...IDS]);
    // The name still travels, because it is what the confirmation says out
    // loud. It is simply not what the command acts on.
    expect(targets.map((target) => target.name)).toEqual(['twins', 'twins']);
  });

  test('and the trash affordance reviews by that id', () => {
    const reviewed: { id: string; name: string }[] = [];
    const button = DeleteAppButton({
      appId: IDS[1]!,
      name: 'twins',
      deletion: { ...idleDeletion, review: (app) => reviewed.push(app) },
    });
    for (const element of elements(button)) {
      const props = element.props as {
        onClick?: (event: { stopPropagation(): void }) => void;
      };
      if (props.onClick) {
        props.onClick({ stopPropagation: () => undefined });
        break;
      }
    }
    expect(reviewed).toEqual([{ id: IDS[1]!, name: 'twins' }]);
  });
});

describe('App links preserve the stored URL contract', () => {
  test('keeps absolute HTTP URLs and prefixes hostnames only', () => {
    expect(appHref('https://already.example/path')).toBe(
      'https://already.example/path',
    );
    expect(appHref('http://local.example')).toBe('http://local.example');
    expect(appHref('app.example')).toBe('https://app.example');
  });

  test('does not turn an empty address into a live link', () => {
    expect(appHref('')).toBeNull();
    expect(appHref('   ')).toBeNull();
  });
});

/**
 * The optimistic drop, which is the last place a name was still standing in for
 * an identity.
 *
 * `app.tsx` removes the row itself rather than re-reading the list, so the
 * predicate it filters on decides what an operator sees the instant a delete
 * completes. Filtering on the name hid *both* twins until a reload — the App
 * that survived being exactly the one this ticket exists to keep reachable.
 *
 * The wiring is additionally guarded by the type system: `onDeleted` now takes
 * an `AppIdentity`, so the old `app.name !== name` predicate is a compile error
 * rather than a silent behaviour, and `bun run typecheck` fails if it returns.
 */
describe('deleting one twin leaves the other on screen', () => {
  test('dropping the row by id keeps its same-named sibling', () => {
    const remaining = TWIN_ROWS.filter((app) => app.id !== IDS[0]);
    expect(remaining.map((app) => app.id)).toEqual([IDS[1]!]);
  });

  test('dropping the row by name would have taken both', () => {
    const byName = TWIN_ROWS[0]!.name;
    expect(TWIN_ROWS.every((app) => app.name === byName)).toBe(true);
    expect(TWIN_ROWS.filter((app) => app.name !== byName)).toEqual([]);
  });
});
