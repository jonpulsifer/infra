/**
 * The assertions `views.test.tsx` cannot make.
 *
 * That file's own header explains why it renders through
 * `renderToStaticMarkup`: every rule it checks is a statement about what a
 * given state looks like, and SSR is the right depth for that. The bugs this
 * file exists for are not that shape — they are React **preserving** state
 * across a transition of the *same mounted instance*, and
 * `renderToStaticMarkup` cannot even observe that class of bug:
 * it never keeps a fiber tree alive between calls (no reconciliation happens)
 * and it never runs `useEffect` at all (SSR effects are a no-op by design).
 * Proving either one means mounting once and re-rendering with a changed prop,
 * which needs a live `react-dom/client` root — and that needs *something*
 * DOM-shaped to render into.
 *
 * The repo has no jsdom/happy-dom (checked: absent from `package.json`,
 * absent from `bun.lock`, no DOM global in the Bun runtime itself), and
 * adding one is out of scope for a regression test. `test/harness/dom.ts` is
 * the subset `react-dom/client`'s host config and the
 * `@radix-ui/react-collapsible` tree actually call, and its own header says
 * what that subset is and why it is a module rather than a copy per file.
 *
 * The second half of the file mounts the **route table** rather than one view,
 * for the same structural reason: navigating between two Deploys of one App
 * changes a prop and nothing else, so what happens to the mounted instance *is*
 * the behaviour under test. `fetch` and `WebSocket` are stubbed on the same
 * globals the shim already owns — the client reaches the network through
 * exactly those two and nothing else.
 */
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

/** Depth-first search for the first element whose text passes `match`. */
function findButton(
  root: FakeNode,
  match: (text: string) => boolean,
): FakeNode | null {
  if (root.nodeType === ELEMENT_NODE && match(root.textContent)) {
    // Only descend into leaves once no deeper element also matches, so the
    // button itself (not some ancestor `div`) is what's returned.
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

/**
 * What the mounted route table is allowed to answer with.
 *
 * The screens reach the network through exactly two globals — `client.ts` is a
 * `fetch` and `stream-client.ts` is a `WebSocket`, both stated in their own
 * headers — so replacing those two is the whole seam, with no module mocking
 * and no injected transport that only a test would ever pass.
 *
 * Deliberately a *deferred* answer rather than a resolved value: the second
 * claim below is entirely about when a response lands relative to a
 * navigation, and a stub that resolved eagerly could not express it.
 */
const pending = new Map<number, (deploy: DeployView) => void>();

function answerFor(id: number): Promise<unknown> {
  return new Promise((resolve) => {
    pending.set(id, (deploy) =>
      resolve({ json: async () => ({ ok: true, value: { deploy } }) }),
    );
  });
}

/** Resolve one Deploy's in-flight read and let React commit the result. */
async function answer(id: number, deploy: DeployView): Promise<void> {
  const respond = pending.get(id);
  if (!respond) throw new Error(`nothing is asking for deploy ${id}`);
  pending.delete(id);
  await act(async () => {
    respond(deploy);
  });
}

/**
 * Installed in `beforeAll` rather than at import, because these are globals and
 * a file's imports are evaluated before the file that installed them last has
 * restored: capturing the previous values at the moment this file's tests start
 * is what keeps two mounted-test files from restoring each other's shim.
 */
let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    // `subscribeAttempt` opens one of these as soon as the first read returns.
    // Nothing here pushes events — the claims below are about the read — so it
    // only has to be constructible and closeable.
    WebSocket: class {
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      close(): void {}
    },
    // Every command goes through this, and the id it is asking about is in the
    // body rather than the path: `pathFor` names the command, not the object.
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
    // The exact case §4/§18 create: a LIVE_TEXT runner (`buildFailed`'s
    // fixture) has already released log lines while `status` is still
    // `running` — `BuildOutput` renders `Transcript` the moment `log` is
    // non-null, which is before the build is known to be red or green.
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

    // Mounted mid-build: `Transcript`'s own contract (deploy-detail.tsx
    // ~642-653) is "shut on green, open on red" — `running` is neither, so it
    // starts collapsed. This is the state that used to persist forever.
    expect(trigger()?.getAttribute('data-state')).toBe('closed');

    act(() => {
      root.render(<DeployDetail view={failedView} />);
    });

    // Same mounted instance, `build.status` now `failed`. Without the
    // prior-status effect this stays `closed` — React does not re-run a
    // `useState` initializer on an update, so the collapsed trigger from the
    // first render is exactly what a reader would find on the terminal red
    // screen. With the effect, the trigger flips to `open`.
    expect(trigger()?.getAttribute('data-state')).toBe('open');

    act(() => {
      root.unmount();
    });
  });
});

/**
 * Ticket 08, item 3, as far as a test can carry it.
 *
 * The criterion names four presentations — "phase, diagnosis, checklist, and
 * log presentation" — and one condition, "without a page refresh". The
 * condition is what makes it awkward to test: nothing here is a page, so what
 * a test can prove is the half that is a claim about code. `app.tsx`'s
 * `DeployScreen` re-issues `getDeployDetail` on every attempt event and hands
 * the result down as a new `view` prop, and the streaming half of that is
 * already asserted by `streams.test.ts` and `stream-client.test.ts`. What was
 * never asserted is the other end: that a **mounted** `DeployDetail` handed a
 * newer view actually replaces all four, rather than showing the state it was
 * mounted in.
 *
 * That is not a re-statement of "React re-renders on new props". This screen
 * holds four independent `useState`s that are seeded from the view and are
 * therefore free to survive it — `BuildDrawer`, `DeployDrawer`, `Transcript`
 * and the diagnosis evidence — and the test above exists because one of them
 * did exactly that. Every one of them is between the reader and one of the
 * four presentations this criterion names.
 *
 * **The ticket's own bar is still a real terminal Deploy watched on the real
 * screen**, which no test replaces. This is the regression guard underneath it.
 */
describe('the mounted Deploy screen replaces what a newer view says', () => {
  test('a running build going red moves phase, diagnosis, checklist and log together', () => {
    // One transition, chosen because it is the only one that moves all four at
    // once: `building` is `LIVE_STATUS` with no log text and a full resource
    // checklist, `buildFailed` is red with a diagnosis, a failed step and eight
    // lines of runner output.
    const building: DeployView = DEPLOY_SCENARIOS.building;
    const failed: DeployView = DEPLOY_SCENARIOS.buildFailed;

    const container = dom.document.createElement('div');
    let root!: Root;
    act(() => {
      root = createRoot(container as unknown as Element);
      root.render(<DeployDetail view={building} />);
    });
    const screen = () => container.textContent;

    // Phase, and the headline under it.
    expect(screen()).toContain(building.phaseWord);
    expect(screen()).toContain(building.headline);
    // Diagnosis: there is none while it is building, and an empty panel would
    // be worse than none.
    expect(screen()).not.toContain('BUILD_FAILED');
    // Checklist: the deploy-side one is present and every resource is waiting,
    // and the build-side one has `run build` still going.
    expect(screen()).toContain(`Resources on ${building.target}`);
    expect(screen()).toContain('14s');
    // Log presentation: §4's `LIVE_STATUS` sentence stands in for text that
    // this runner will not release until the run ends.
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
    // The resource checklist goes away with the release it described, and the
    // build checklist reports the step that died.
    expect(screen()).not.toContain(`Resources on ${failed.target}`);
    expect(screen()).toContain('2.9s');
    expect(screen()).not.toContain('14s');
    // The `LIVE_STATUS` sentence is replaced by the text it was standing in
    // for — which is only reachable because `Transcript` springs open on red,
    // the claim the describe above pins.
    expect(screen()).not.toContain('reports step status live');
    expect(screen()).toContain('Failed to compile');

    act(() => {
      root.unmount();
    });
  });
});

/**
 * Switching between two Deploys of the same App.
 *
 * The bug this pins only exists between two objects of the *same shape*.
 * Navigating App → App changes enough of the tree that the screen is rebuilt;
 * Deploy → Deploy changes one prop, so React keeps the mounted `DeployScreen`
 * and everything it is holding — the checklist, the log, the diagnosis and the
 * phase of the Deploy you just left — until a read for the new one returns.
 *
 * These render the route table rather than `DeployScreen`, because the fix is a
 * key on the element the table creates. A test that rendered `DeployScreen`
 * directly would have to supply that key itself, and would then be asserting
 * its own prop.
 */
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

    // Deploy 42, in full: its phase, its diagnosis, its failed step, its log.
    expect(screen.text()).toContain(previous.headline);
    expect(screen.text()).toContain('BUILD_FAILED');
    expect(screen.text()).toContain('run build');
    expect(screen.text()).toContain('Failed to compile');

    screen.show('/deploys/43');

    // Before deploy 43 has answered. Every one of 42's four presentations is
    // already gone — the screen says it is loading rather than showing another
    // release's evidence under this one's id.
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
    // Invisible on a fast connection and certain on a slow one: the screen
    // polls, so a read issued for deploy 42 can still be in flight when 43 is
    // asked for and resolve *after* 43 has rendered. Nothing about the order
    // the network answers in is under this screen's control, so the guarantee
    // has to be structural — 42's read has no state cell left to write into.
    const screen = mount();
    screen.show('/deploys/42');

    // 42 is asked for and never answered.
    expect(pending.has(42)).toBe(true);

    screen.show('/deploys/43');
    await answer(43, current);
    expect(screen.text()).toContain(current.headline);

    // And now the response for the Deploy that was navigated away from lands.
    await answer(42, previous);

    expect(screen.text()).toContain(current.headline);
    expect(screen.text()).not.toContain(previous.headline);
    expect(screen.text()).not.toContain('BUILD_FAILED');

    screen.unmount();
  });
});
