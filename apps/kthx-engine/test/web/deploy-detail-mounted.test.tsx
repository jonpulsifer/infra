// Mounts a live `react-dom/client` root: these bugs are state kept across
// re-renders of one instance, which `renderToStaticMarkup` never runs.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeployView } from '../../src/commands/views.ts';
import { Screen } from '../../src/web/app.tsx';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { DEPLOY_SCENARIOS } from '../fixtures/scenarios.ts';
import {
  type DomShim,
  ELEMENT_NODE,
  type FakeNode,
  installDomShim,
} from '../harness/dom.ts';

function findButton(
  root: FakeNode,
  match: (text: string) => boolean,
): FakeNode | null {
  if (root.nodeType === ELEMENT_NODE && match(root.textContent)) {
    // The deepest match wins, so the button is returned, not an ancestor.
    const child = root.childNodes.find(
      (c) => c.nodeType === ELEMENT_NODE && match(c.textContent),
    );
    if (!child) return root;
  }
  for (const child of root.childNodes) {
    const found = findButton(child, match);
    if (found) return found;
  }
  return null;
}

// Deferred, because the last test is about when a response lands relative to
// a navigation.
const pending = new Map<number, (deploy: DeployView) => void>();

function answerFor(id: number): Promise<unknown> {
  return new Promise((resolve) => {
    pending.set(id, (deploy) =>
      resolve({ json: async () => ({ ok: true, value: { deploy } }) }),
    );
  });
}

async function answer(id: number, deploy: DeployView): Promise<void> {
  const respond = pending.get(id);
  if (!respond) throw new Error(`nothing is asking for deploy ${id}`);
  pending.delete(id);
  await act(async () => {
    respond(deploy);
  });
}

// Installed in `beforeAll`, not at import, so two mounted-test files never
// restore each other's globals.
let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    // `subscribeAttempt` opens one after the first read; nothing here pushes events.
    WebSocket: class {
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      close(): void {}
    },
    // The Deploy id is in the body; the path names only the command.
    fetch: async (_url: string, init?: { body?: string }) => {
      const { id } = JSON.parse(init?.body ?? '{}') as { id?: number };
      if (id === undefined) throw new Error('a command asked for no id');
      return await answerFor(id);
    },
  });
});

afterAll(() => dom.restore());

describe('Transcript re-derives open on a build status change', () => {
  test('a running LIVE_TEXT build that turns failed springs the transcript open', () => {
    // A LIVE_TEXT runner releases log lines while `status` is still `running`,
    // so `Transcript` mounts before the build is red or green.
    const runningView: DeployView = {
      ...DEPLOY_SCENARIOS.building,
      build: { ...DEPLOY_SCENARIOS.buildFailed.build, status: 'running' },
    };
    const failedView: DeployView = DEPLOY_SCENARIOS.buildFailed;

    const container = dom.document.createElement('div');
    let root!: Root;
    act(() => {
      root = createRoot(container as unknown as Element);
      root.render(<DeployDetail view={runningView} />);
    });

    const runnerName = failedView.build?.runner ?? '';
    const trigger = () =>
      findButton(container, (text) => text.includes(`${runnerName} output`));

    // `Transcript` is shut on green and open on red; `running` starts it shut.
    expect(trigger()?.getAttribute('data-state')).toBe('closed');

    act(() => {
      root.render(<DeployDetail view={failedView} />);
    });

    // React does not re-run a `useState` initializer on update, so an effect opens it.
    expect(trigger()?.getAttribute('data-state')).toBe('open');

    act(() => {
      root.unmount();
    });
  });
});

// `DeployDetail` seeds several `useState`s from its view, so a newer view must
// replace each of them.
describe('the mounted Deploy screen replaces what a newer view says', () => {
  test('a running build going red moves phase, diagnosis, checklist and log together', () => {
    // The one fixture transition that moves phase, diagnosis, checklist and log at once.
    const building: DeployView = DEPLOY_SCENARIOS.building;
    const failed: DeployView = DEPLOY_SCENARIOS.buildFailed;

    const container = dom.document.createElement('div');
    let root!: Root;
    act(() => {
      root = createRoot(container as unknown as Element);
      root.render(<DeployDetail view={building} />);
    });
    const screen = () => container.textContent;

    expect(screen()).toContain(building.phaseWord);
    expect(screen()).toContain(building.headline);
    expect(screen()).not.toContain('BUILD_FAILED');
    // The deploy checklist, and the build checklist with `run build` still going.
    expect(screen()).toContain(`Resources on ${building.target}`);
    expect(screen()).toContain('14s');
    // A `LIVE_STATUS` runner releases no log text until the run ends.
    expect(screen()).toContain('reports step status live');
    expect(screen()).not.toContain('Failed to compile');

    act(() => {
      root.render(<DeployDetail view={failed} />);
    });

    expect(screen()).toContain(failed.phaseWord);
    expect(screen()).toContain(failed.headline);
    expect(screen()).not.toContain(building.headline);
    expect(screen()).toContain('BUILD_FAILED');
    expect(screen()).toContain(failed.diagnosis?.detail ?? '');
    expect(screen()).not.toContain(`Resources on ${failed.target}`);
    expect(screen()).toContain('2.9s');
    expect(screen()).not.toContain('14s');
    // The log text is reachable only because `Transcript` opens on red.
    expect(screen()).not.toContain('reports step status live');
    expect(screen()).toContain('Failed to compile');

    act(() => {
      root.unmount();
    });
  });
});

// Deploy to Deploy changes one prop, so only the route table's key remounts the
// screen; these mount the table, which writes that key.
describe('switching between two Deploys of one App', () => {
  const previous: DeployView = {
    ...DEPLOY_SCENARIOS.buildFailed,
    id: 42,
    buildId: 41,
  };
  const current: DeployView = {
    ...DEPLOY_SCENARIOS.live,
    id: 43,
    buildId: 43,
    headline: 'Deployed 4 seconds ago',
  };

  beforeEach(() => {
    pending.clear();
  });

  const mount = () => {
    const container = dom.document.createElement('div');
    let root!: Root;
    act(() => {
      root = createRoot(container as unknown as Element);
    });
    return {
      text: () => container.textContent,
      show: (path: string) =>
        act(() => {
          root.render(<Screen path={path} onNavigate={() => undefined} />);
        }),
      unmount: () => act(() => root.unmount()),
    };
  };

  test('the second Deploy carries none of the first one’s evidence', async () => {
    const screen = mount();
    screen.show('/deploys/42');
    await answer(42, previous);

    expect(screen.text()).toContain(previous.headline);
    expect(screen.text()).toContain('BUILD_FAILED');
    expect(screen.text()).toContain('run build');
    expect(screen.text()).toContain('Failed to compile');

    screen.show('/deploys/43');

    // Before 43 answers, none of 42's evidence remains.
    expect(screen.text()).not.toContain(previous.headline);
    expect(screen.text()).not.toContain('BUILD_FAILED');
    expect(screen.text()).not.toContain('Failed to compile');

    await answer(43, current);

    expect(screen.text()).toContain(current.headline);
    expect(screen.text()).not.toContain(previous.headline);
    expect(screen.text()).not.toContain('BUILD_FAILED');
    expect(screen.text()).not.toContain('Failed to compile');

    screen.unmount();
  });

  test('a read for the Deploy you left cannot write into the one on screen', async () => {
    // A read for 42 can land after 43 renders; the remount leaves it no state
    // to write into.
    const screen = mount();
    screen.show('/deploys/42');

    expect(pending.has(42)).toBe(true);

    screen.show('/deploys/43');
    await answer(43, current);
    expect(screen.text()).toContain(current.headline);

    await answer(42, previous);

    expect(screen.text()).toContain(current.headline);
    expect(screen.text()).not.toContain(previous.headline);
    expect(screen.text()).not.toContain('BUILD_FAILED');

    screen.unmount();
  });
});
