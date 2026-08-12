/**
 * Just enough DOM for `react-dom/client` to mount into.
 *
 * The repo has no jsdom/happy-dom (absent from `package.json`, absent from
 * `bun.lock`, and the Bun runtime has no DOM global of its own), and adding one
 * to run a handful of mounted tests is a dependency the suite does not otherwise
 * need. What follows is not a DOM implementation; it is the subset
 * `react-dom/client`'s host config and the component trees under test actually
 * call — `appendChild`/`insertBefore`/`removeChild`,
 * `setAttribute`/`getAttribute` (Radix reports `data-state` and `hidden`
 * through these rather than through an IDL property, which is what makes them a
 * reliable read), `style` as a plain object, a no-op `addEventListener`
 * (nothing here simulates a click) and a `getBoundingClientRect` that satisfies
 * a layout effect without a layout.
 *
 * **Why a module and not a copy in each file.** Two of them exist now — the
 * mounted route table and the mounted shell — and the second one arrived
 * because a whole feature's only wiring was observed by nothing. A second copy
 * of this shim would be a second answer to "what does React need", and the copy
 * that fell behind would be the one whose test file mysteriously stopped
 * mounting.
 *
 * **Installed and restored per file, never at import.** These are globals: a
 * `document` left on `globalThis` flips every `typeof window !== 'undefined'`
 * feature check in every file that runs afterwards. {@link installDomShim}
 * captures whatever was there — including the keys a caller passes in `extras`
 * — and `restore()` puts all of it back, so a file that installs in `beforeAll`
 * and restores in `afterAll` leaves the suite exactly as it found it.
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/**
 * `CollapsibleContentImpl` sets a `--radix-collapsible-content-height` custom
 * property alongside ordinary style keys. React DOM routes any `--`-prefixed
 * style key through `style.setProperty` rather than a direct assignment (that
 * split exists for real CSSStyleDeclarations, where custom properties are not
 * reflected as JS properties) — a plain object supports neither, so this is a
 * plain object plus that one method.
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

export class FakeNode {
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
    // `getRootHostContext` reads the container's `tagName` (uppercase, per DOM
    // convention) to seed the SVG/HTML namespace switch; every other fake node
    // just carries it for parity.
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

  /**
   * Just enough of `HTMLSelectElement.options` to mount a `<select>`.
   *
   * React's `updateOptions` runs on every select as it is created — it reads
   * `node.options` and walks it looking for the one whose `value` matches, so a
   * select without that collection throws before the tree is ever on screen.
   * Derived from `childNodes` rather than maintained beside them, so an option
   * React inserts later is in the list without a second write path.
   *
   * Which option ends up marked `selected` is not modelled: nothing here
   * renders a selection, and `textContent` — what these tests read — carries
   * every option's label either way.
   */
  get options(): FakeNode[] {
    return this.childNodes.filter((child) => child.tagName === 'OPTION');
  }

  /**
   * `commitMount` calls this directly on a mounted `input`/`select`/`button`
   * carrying `autoFocus`, so a tree with an autofocused control does not mount
   * without it. There is no focus in this shim — `activeElement` stays `null` —
   * and that is the honest state: nothing here has a viewport to focus into.
   */
  focus(): void {}

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

export class FakeDocument {
  readonly nodeType = 9;
  // Set to `globalThis` once installed as the global `window` —
  // `commitBeforeMutationEffects` reads focus through
  // `container.ownerDocument.defaultView.document`, so `defaultView` has to be
  // the same object as `globalThis.document`'s owner, not a lookalike.
  defaultView: typeof globalThis | undefined;
  // Read by `getActiveElement`; there is no focus in this shim, and `null` says
  // so instead of leaving the property (and the `|| doc.body` fallback it
  // feeds) undefined.
  readonly activeElement: null = null;
  readonly body: null = null;

  // React registers a handful of document-level listeners (selection,
  // composition) alongside the per-root ones. Nothing here simulates input, so
  // these only need to not throw.
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

export interface DomShim {
  /** The document mounted trees are created from. */
  readonly document: FakeDocument;
  /** Put every global this replaced back the way it was. */
  restore(): void;
}

/**
 * Install the shim on `globalThis`.
 *
 * `extras` is where a file states the seams its own tree reaches — a `fetch`, a
 * `WebSocket`, a `location`. They are passed in rather than defaulted because
 * what a stub is allowed to answer is a claim the test is making, and a default
 * answer shared between files would be a claim nobody wrote down.
 */
export function installDomShim(extras: Record<string, unknown> = {}): DomShim {
  const document = new FakeDocument();
  const values: Record<string, unknown> = {
    document,
    // `@radix-ui/react-primitive` does a bare `typeof window !== 'undefined'`
    // feature check on every mount, and react-dom's own focus-restoration pass
    // reads `container.ownerDocument.defaultView.document` — both need `window`
    // to be the same object `document` was installed on.
    window: globalThis,
    // `@radix-ui/react-presence` reads this to decide whether an open/close
    // transition is mid CSS-animation. Nothing here has a stylesheet, so
    // reporting no `animationName` is correct rather than a stub of convenience.
    getComputedStyle: (node: FakeNode) => node.style,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
    // react-dom's focus restoration walks into iframes via
    // `element instanceof window.HTMLIFrameElement`; nothing here ever is one,
    // but the right-hand side still has to be a real constructor.
    HTMLIFrameElement: class {},
    ...extras,
  };

  const previous = new Map<string, unknown>();
  for (const key of Object.keys(values)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
  }
  Object.assign(globalThis, values);
  document.defaultView = globalThis;

  return {
    document,
    restore() {
      Object.assign(globalThis, Object.fromEntries(previous));
    },
  };
}
