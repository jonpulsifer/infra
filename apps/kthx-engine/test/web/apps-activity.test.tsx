// The Apps screen's aside shows the Overview's Builds and Deploys feed, cut
// to its newest rows, from a read of its own.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AppRowsView,
  BuildListItem,
  DeployLedgerItem,
} from '../../src/commands/views.ts';
import type { AppDeletionControls } from '../../src/web/components/delete-app.tsx';
import {
  ACTIVITY_ROWS,
  ActivityAside,
  AppList,
  AppsScreen,
} from '../../src/web/views/apps/list.tsx';
import { activityEntries } from '../../src/web/views/operations/activity.ts';
import { APP_ROWS } from '../fixtures/scenarios.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

const BUILD: BuildListItem = {
  id: 1837,
  appId: 'app-morrow',
  app: 'morrow',
  componentId: 'component-web',
  component: 'web',
  commit: '5bc1000000000000000000000000000000000000',
  targetShape: 'image',
  artifactType: 'image',
  artifactDigest: 'sha256:abc',
  status: 'SUCCEEDED',
  runner: 'Cloud Build',
  when: '13m ago',
  at: '2026-08-03T12:31:00.000Z',
  deployId: 993,
  dispatchWaitingOn: null,
};

const DEPLOY: DeployLedgerItem = {
  id: 993,
  appId: 'app-morrow',
  app: 'morrow',
  buildId: BUILD.id,
  componentId: BUILD.componentId,
  component: BUILD.component,
  targetId: 'target-folly',
  target: 'Folly',
  phase: 'APPLYING',
  commit: BUILD.commit,
  configVersion: '9e2bc1',
  when: 'active',
  at: '2026-08-03T12:44:00.000Z',
  current: true,
  rollbackable: false,
};

/** `count` of each, a minute apart, interleaved so neither kind is all newest. */
function ledger(count: number) {
  const minute = (n: number) =>
    new Date(Date.parse('2026-08-03T12:00:00.000Z') + n * 60_000).toISOString();
  return {
    builds: Array.from(
      { length: count },
      (_, n): BuildListItem => ({ ...BUILD, id: 1800 + n, at: minute(2 * n) }),
    ),
    deploys: Array.from(
      { length: count },
      (_, n): DeployLedgerItem => ({
        ...DEPLOY,
        id: 900 + n,
        at: minute(2 * n + 1),
      }),
    ),
  };
}

function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* elements((node.props as { children?: ReactNode }).children);
}

const idleDeletion: AppDeletionControls = {
  state: { kind: 'idle' },
  review: () => undefined,
  confirm: () => undefined,
  dismiss: () => undefined,
};

describe('activityEntries', () => {
  test('is pure: it leaves its inputs alone and answers the same twice', () => {
    const { builds, deploys } = ledger(3);
    const frozen = {
      builds: Object.freeze(builds.map((build) => Object.freeze(build))),
      deploys: Object.freeze(deploys.map((deploy) => Object.freeze(deploy))),
    };
    const first = activityEntries(frozen.builds, frozen.deploys);
    expect(activityEntries(frozen.builds, frozen.deploys)).toEqual(first);
    expect(frozen.builds.map((build) => build.id)).toEqual([1800, 1801, 1802]);
  });

  test('interleaves both kinds, newest first', () => {
    const { builds, deploys } = ledger(2);
    expect(activityEntries(builds, deploys).map((entry) => entry.id)).toEqual([
      'deploy:901',
      'build:1801',
      'deploy:900',
      'build:1800',
    ]);
  });

  test('opens each entry where its ledger does', () => {
    const [deploy, build] = activityEntries([BUILD], [DEPLOY]);
    expect(deploy).toMatchObject({
      path: '/deploys/993',
      appPath: '/apps/app-morrow',
      buildPath: '/builds/1837',
      status: 'applying',
    });
    expect(build).toMatchObject({ path: '/builds/1837', status: 'succeeded' });
  });

  test('has nothing to say about an empty ledger', () => {
    expect(activityEntries([], [])).toEqual([]);
  });
});

describe('the Activity aside', () => {
  test(`shows at most ${ACTIVITY_ROWS} rows, the newest`, () => {
    const { builds, deploys } = ledger(ACTIVITY_ROWS);
    const markup = renderToStaticMarkup(
      <ActivityAside
        entries={activityEntries(builds, deploys)}
        onNavigate={() => undefined}
      />,
    );
    expect(markup.match(/<li/g)?.length).toBe(ACTIVITY_ROWS);
    expect(markup).toContain(`Deploy ${900 + ACTIVITY_ROWS - 1}`);
    expect(markup).not.toContain('Build 1800');
  });

  test('View all goes to the Deploy ledger', () => {
    const visited: string[] = [];
    const tree = ActivityAside({
      entries: [],
      onNavigate: (path) => visited.push(path),
    });
    const viewAll = [...elements(tree)].find(
      (element) =>
        (element.props as { children?: ReactNode }).children === 'View all',
    );
    if (!viewAll) throw new Error('the aside offers no View all');
    (viewAll.props as { onClick: () => void }).onClick();
    expect(visited).toEqual(['/deploys']);
  });

  test('a row opens its own Build or Deploy', () => {
    const visited: string[] = [];
    const tree = ActivityAside({
      entries: activityEntries([BUILD], [DEPLOY]),
      onNavigate: (path) => visited.push(path),
    });
    for (const element of elements(tree)) {
      const props = element.props as { onClick?: () => void };
      if (element.type === 'button' && props.onClick) props.onClick();
    }
    expect(visited).toEqual(['/deploys', '/deploys/993', '/builds/1837']);
  });

  test('a failed read is a line in the aside', () => {
    const markup = renderToStaticMarkup(
      <ActivityAside
        entries={null}
        failure="the ledger is down"
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('Activity could not be read: the ledger is down');
    expect(markup).toContain('View all');
    expect(markup).not.toContain('<ol');
  });

  test('the list makes room for it only when it is given one', () => {
    const column = '2xl:grid-cols-[minmax(0,1fr)_20rem]';
    const without = renderToStaticMarkup(
      <AppList
        view={APP_ROWS}
        deletion={idleDeletion}
        onNavigate={() => undefined}
      />,
    );
    const beside = renderToStaticMarkup(
      <AppList
        view={APP_ROWS}
        deletion={idleDeletion}
        onNavigate={() => undefined}
        aside={<ActivityAside entries={[]} onNavigate={() => undefined} />}
      />,
    );
    expect(without).not.toContain(column);
    expect(without).not.toContain('aria-label="Activity"');
    expect(beside).toContain(column);
    expect(beside).toContain('aria-label="Activity"');
  });
});

describe('the Apps screen reads its aside apart from its list', () => {
  const VIEW: AppRowsView = { ...APP_ROWS, next: null };
  let ledgerAnswer: 'ok' | 'refused' = 'ok';
  const asked: { name: string; input: unknown }[] = [];
  let dom: DomShim;

  beforeAll(() => {
    dom = installDomShim({
      fetch: async (url: string, init?: { body?: string }) => {
        const name = url.slice(url.lastIndexOf('/') + 1);
        asked.push({ name, input: JSON.parse(init?.body ?? '{}') });
        const { builds, deploys } = ledger(ACTIVITY_ROWS);
        const answers: Record<string, unknown> = {
          listAppRows: { ok: true, value: VIEW },
          listBuilds: { ok: true, value: { builds, nextBefore: null } },
          listAllDeploys:
            ledgerAnswer === 'ok'
              ? { ok: true, value: { deploys, nextBefore: null } }
              : {
                  ok: false,
                  failure: { code: 'INTERNAL', message: 'the ledger is down' },
                },
        };
        const answer = answers[name];
        if (answer === undefined) throw new Error(`unexpected read ${name}`);
        return { status: 200, json: async () => answer };
      },
    });
  });

  afterAll(() => dom.restore());

  async function mount(): Promise<{ text: string; unmount: () => void }> {
    const container = dom.document.createElement('div');
    let root!: Root;
    await act(async () => {
      root = createRoot(container as unknown as Element);
      root.render(<AppsScreen onNavigate={() => undefined} />);
    });
    await act(async () => {});
    return {
      text: container.textContent,
      unmount: () => act(() => root.unmount()),
    };
  }

  test(`asks each ledger for its newest ${ACTIVITY_ROWS}`, async () => {
    ledgerAnswer = 'ok';
    asked.length = 0;
    const screen = await mount();
    expect(asked).toContainEqual({
      name: 'listBuilds',
      input: { limit: ACTIVITY_ROWS },
    });
    expect(asked).toContainEqual({
      name: 'listAllDeploys',
      input: { limit: ACTIVITY_ROWS },
    });
    expect(screen.text).toContain('Activity');
    expect(screen.text).toContain(`Deploy ${900 + ACTIVITY_ROWS - 1}`);
    screen.unmount();
  });

  test('a refused ledger leaves the list standing', async () => {
    ledgerAnswer = 'refused';
    const screen = await mount();
    expect(screen.text).toContain('Activity could not be read');
    expect(screen.text).toContain('weather-card');
    expect(screen.text).not.toContain('Failed to load Apps');
    screen.unmount();
  });
});
