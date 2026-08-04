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
 * adding one is out of scope for a single regression test. What follows is a
 * few dozen lines of the smallest object graph `react-dom/client`'s host
 * config and the `@radix-ui/react-collapsible` tree actually call —
 * `appendChild`/`insertBefore`/`removeChild`, `setAttribute`/`getAttribute`
 * (Radix reports `data-state` and `hidden` through these, never through a
 * direct IDL property, which is what makes them a reliable read here),
 * `style` as a plain object, a no-op `addEventListener` (nothing here
 * simulates a click), and a `getBoundingClientRect` that satisfies
 * `CollapsibleContent`'s layout-effect without a real layout. It is not a DOM
 * implementation; it is the subset this one component tree touches.
 *
 * The second half of the file mounts the **route table** rather than one view,
 * for the same structural reason: navigating between two Deploys of one App
 * changes a prop and nothing else, so what happens to the mounted instance *is*
 * the behaviour under test. `fetch` and `WebSocket` are stubbed on the same
 * globals the shim already owns — the client reaches the network through
 * exactly those two and nothing else.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Screen } from '../../src/web/app.tsx';
import type { DeployView } from '../../src/web/model.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { DEPLOY_SCENARIOS } from '../fixtures/scenarios.ts';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * `CollapsibleContentImpl` sets a `--radix-collapsible-content-height`
 * custom property alongside ordinary style keys. React DOM routes any
 * `--`-prefixed style key through `style.setProperty` rather than a direct
 * assignment (that split exists for real CSSStyleDeclarations, where custom
 * properties aren't reflected as JS properties) — a plain object supports
 * neither, so this is a plain object plus that one method.
 */
class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string): void {
    this[name] = value;
  }
  removeProperty(name: string): void {
    delete this[name];
  }
}

class FakeNode {
  readonly nodeType: number;
  readonly ownerDocument: FakeDocument;
  readonly namespaceURI?: string;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  readonly style = new FakeStyle();
  readonly tagName: string;
  private readonly attrs = new Map<string, string>();
  private text: string;

  constructor(
    nodeType: number,
    ownerDocument: FakeDocument,
    text = '',
    namespaceURI?: string,
    tag = '',
  ) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.text = text;
    this.namespaceURI = namespaceURI;
    // `getRootHostContext` reads the container's `tagName` (uppercase, per
    // DOM convention) to seed the SVG/HTML namespace switch; every other
    // fake node just carries it for parity.
    this.tagName = tag.toUpperCase();
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && index === -1) {
      this.childNodes.push(child);
    } else if (ref) {
      this.childNodes.splice(index, 0, child);
    } else {
      this.childNodes.push(child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  contains(node: FakeNode): boolean {
    for (let n: FakeNode | null = node; n; n = n.parentNode) {
      if (n === this) return true;
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) ?? null) : null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
  }

  get nodeValue(): string | null {
    return this.nodeType === TEXT_NODE ? this.text : null;
  }
  set nodeValue(value: string) {
    this.text = value;
  }

  get textContent(): string {
    return this.nodeType === TEXT_NODE
      ? this.text
      : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value)
      this.appendChild(new FakeNode(TEXT_NODE, this.ownerDocument, value));
  }
}

class FakeDocument {
  readonly nodeType = 9;
  // Set to `globalThis` once the test installs it as the global `window` —
  // `commitBeforeMutationEffects` reads focus through
  // `container.ownerDocument.defaultView.document`, so `defaultView` has to
  // be the same object as `globalThis.document`'s owner, not a lookalike.
  defaultView: typeof globalThis | undefined;
  // Read by `getActiveElement`; there is no focus in this shim, and `null`
  // says so instead of leaving the property (and the `|| doc.body` fallback
  // it feeds) undefined.
  readonly activeElement: null = null;
  readonly body: null = null;

  // React registers a handful of document-level listeners (selection,
  // composition) alongside the per-root ones. Nothing here simulates input,
  // so these only need to not throw.
  addEventListener(): void {}
  removeEventListener(): void {}

  createElement(tag: string): FakeNode {
    return new FakeNode(ELEMENT_NODE, this, '', undefined, tag);
  }
  createElementNS(ns: string, tag: string): FakeNode {
    return new FakeNode(ELEMENT_NODE, this, '', ns, tag);
  }
  createTextNode(text: string): FakeNode {
    return new FakeNode(TEXT_NODE, this, text);
  }
  createComment(text: string): FakeNode {
    return new FakeNode(8, this, text);
  }
}

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
 * The shim is installed for the whole file rather than one `describe`, because
 * more than one claim needs a mounted tree and installing it twice would leave
 * the second restore holding the first shim as its "previous". Restoring at all
 * is what keeps the rest of the suite honest: a `document` left on `globalThis`
 * flips every `typeof window !== 'undefined'` feature check in the files that
 * run after this one.
 */
const fakeDocument = new FakeDocument();
const previousDocument = (globalThis as { document?: unknown }).document;
const previousWindow = (globalThis as { window?: unknown }).window;
const previousGetComputedStyle = (globalThis as { getComputedStyle?: unknown })
  .getComputedStyle;
const previousRaf = (globalThis as { requestAnimationFrame?: unknown })
  .requestAnimationFrame;
const previousCancelRaf = (globalThis as { cancelAnimationFrame?: unknown })
  .cancelAnimationFrame;
const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
  .IS_REACT_ACT_ENVIRONMENT;
const previousHTMLIFrameElement = (
  globalThis as { HTMLIFrameElement?: unknown }
).HTMLIFrameElement;
const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
const previousFetch = globalThis.fetch;

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

Object.assign(globalThis, {
  document: fakeDocument,
  // `@radix-ui/react-primitive` does a bare `typeof window !== 'undefined'`
  // feature-check on every mount, and react-dom's own focus-restoration
  // pass reads `container.ownerDocument.defaultView.document` — both need
  // `window` to be the same object `document` was installed on.
  window: globalThis,
  // `@radix-ui/react-presence` reads this to decide whether an open/close
  // transition is mid CSS-animation. Nothing here has a stylesheet, so
  // reporting no `animationName` is correct, not a stub of convenience.
  getComputedStyle: (node: FakeNode) => node.style,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
  // react-dom's focus restoration walks into iframes via
  // `element instanceof window.HTMLIFrameElement`; nothing here ever is
  // one, but the right-hand side still has to be a real constructor.
  HTMLIFrameElement: class {},
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
fakeDocument.defaultView = globalThis;

afterAll(() => {
  Object.assign(globalThis, {
    document: previousDocument,
    window: previousWindow,
    getComputedStyle: previousGetComputedStyle,
    requestAnimationFrame: previousRaf,
    cancelAnimationFrame: previousCancelRaf,
    IS_REACT_ACT_ENVIRONMENT: previousActEnv,
    HTMLIFrameElement: previousHTMLIFrameElement,
    WebSocket: previousWebSocket,
    fetch: previousFetch,
  });
});

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

    const container = fakeDocument.createElement('div');
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

    const container = fakeDocument.createElement('div');
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
    const container = fakeDocument.createElement('div');
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
