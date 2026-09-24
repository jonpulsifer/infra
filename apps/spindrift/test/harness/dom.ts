/**
 * The subset of the DOM that `react-dom/client` and the trees under test call,
 * since the repo has no jsdom or happy-dom.
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/** React DOM sets `--` custom properties, like Radix's, via `setProperty`. */
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
    // `getRootHostContext` reads the container's uppercase `tagName` to choose
    // between the SVG and HTML namespaces.
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
   * React's `updateOptions` walks this on every `<select>` it creates. Which
   * option is `selected` is not modelled.
   */
  get options(): FakeNode[] {
    return this.childNodes.filter((child) => child.tagName === 'OPTION');
  }

  /** `commitMount` calls this on an `autoFocus` control. Nothing takes focus. */
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
  // Set to `globalThis` on install: `commitBeforeMutationEffects` reads focus
  // through `container.ownerDocument.defaultView.document`.
  defaultView: typeof globalThis | undefined;
  // Read by React's `getActiveElement`; `null` means nothing has focus.
  readonly activeElement: null = null;
  readonly body: null = null;

  // Recorded so a test can fire `visibilitychange` at `usePoll`. Only
  // `dispatch` fires anything.
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const forType = this.listeners.get(type) ?? new Set();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

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
  readonly document: FakeDocument;
  /** Restores every global the shim replaced, `extras` included. */
  restore(): void;
}

/**
 * Restore in the same file: a global `document` flips every `typeof window`
 * check in files that run later. `extras` adds globals, such as a `fetch`.
 */
export function installDomShim(extras: Record<string, unknown> = {}): DomShim {
  const document = new FakeDocument();
  const values: Record<string, unknown> = {
    document,
    // Radix checks `typeof window`, and react-dom reads focus through
    // `defaultView.document`, so `window` is the object `document` is on.
    window: globalThis,
    // `@radix-ui/react-presence` reads `animationName`, which stays unset here.
    getComputedStyle: (node: FakeNode) => node.style,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
    // react-dom's focus restoration tests `instanceof window.HTMLIFrameElement`.
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
