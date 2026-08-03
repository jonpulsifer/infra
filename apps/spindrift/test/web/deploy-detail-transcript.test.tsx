/**
 * The one assertion `views.test.tsx` cannot make (ticket 08, criterion 3).
 *
 * That file's own header explains why it renders through
 * `renderToStaticMarkup`: every rule it checks is a statement about what a
 * given state looks like, and SSR is the right depth for that. The bug this
 * file exists for is not that shape — it is React **preserving** `Transcript`'s
 * `open` state across a running→failed transition of the *same mounted
 * instance*, and `renderToStaticMarkup` cannot even observe that class of bug:
 * it never keeps a fiber tree alive between calls (no reconciliation happens)
 * and it never runs `useEffect` at all (SSR effects are a no-op by design).
 * Proving the fix means mounting once and re-rendering with a changed prop,
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
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

describe('Transcript re-derives open on a build status change', () => {
  const fakeDocument = new FakeDocument();
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousGetComputedStyle = (
    globalThis as { getComputedStyle?: unknown }
  ).getComputedStyle;
  const previousRaf = (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame;
  const previousCancelRaf = (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame;
  const previousActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousHTMLIFrameElement = (
    globalThis as { HTMLIFrameElement?: unknown }
  ).HTMLIFrameElement;

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
    });
  });

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
