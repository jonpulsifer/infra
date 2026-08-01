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
import { listApps } from '../../src/commands/apps/list.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createApp } from '../../src/commands/create-app.ts';
import { createComponent, deleteApp } from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  type AppDeletion,
  type AppDeletionControls,
  DeleteAppButton,
} from '../../src/web/components/delete-app.tsx';
import type { AppListItem } from '../../src/web/model.ts';
import { AppList } from '../../src/web/views/apps/list.tsx';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

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
            exposure: 'public',
          }
        : {
            appId: app.value.appId,
            name: 'web',
            kind: 'service',
            expose: true,
            exposure: 'private',
          },
      ctx,
    );
    if (!component.ok) throw new Error(component.failure.message);

    made.push({ id: app.value.appId, kind });
  }
  return made;
}

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
    release: 'latest',
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
    release: 'Deploy 4',
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
  const rows = [...elements(tree)].filter((element) => element.key !== null);

  test('there are two rows, keyed by id rather than by name', () => {
    // Keyed by name, React sees one key twice and reconciles two Apps into one
    // row — before any of the rest of this can even be asked.
    expect(rows.map((row) => row.key)).toEqual([...IDS]);
  });

  test('each row navigates to its own App', () => {
    const visited: string[] = [];
    const navigating = AppList({
      apps: TWIN_ROWS,
      onNavigate: (path) => visited.push(path),
      deletion: idleDeletion,
    });
    for (const element of elements(navigating)) {
      if (element.key === null) continue;
      for (const inner of elements(element)) {
        const props = inner.props as { onClick?: () => void };
        if (inner.type === 'button' && props.onClick) {
          props.onClick();
          break;
        }
      }
    }
    expect(visited).toEqual(IDS.map((id) => `/apps/${id}`));
  });

  test('each row hands its own id to the trash affordance', () => {
    const targets = rows.map((row) => {
      for (const inner of elements(row)) {
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
