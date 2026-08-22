/**
 * Monaco, loaded from the CDN the AMD way — its own loader script, not an
 * import, because Monaco ships no ESM build wired for a bundler-free client.
 *
 * `loadMonaco()` is memoised so every `FunctionScreen` mount shares one script
 * tag, one compiler configuration, and one theme listener rather than
 * reconfiguring `javascriptDefaults` — a module-global set of rules — on every
 * open. Types are a small structural interface over `unknown`, not `any`: this
 * file only calls the handful of methods the editor screen needs, and casting
 * the rest away would let a typo in one of them through silently.
 */

const VERSION = '0.52.2';
const BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${VERSION}/min/vs`;

export interface MonacoModel {
  dispose(): void;
}

export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoEditorInstance {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeModelContent(listener: () => void): MonacoModel;
  updateOptions(options: Record<string, unknown>): void;
  layout(dimension?: { readonly width: number; readonly height: number }): void;
  addCommand(keybinding: number, handler: () => void): void;
  getSelection(): MonacoRange;
  executeEdits(
    source: string,
    edits: readonly {
      readonly range: MonacoRange;
      readonly text: string;
      readonly forceMoveMarkers?: boolean;
    }[],
  ): boolean;
  focus(): void;
  dispose(): void;
}

/** The subset of `monaco.editor.IStandaloneThemeData` this app fills in. */
interface EditorThemeData {
  readonly base: 'vs' | 'vs-dark';
  readonly inherit: boolean;
  readonly colors: Record<string, string>;
  readonly rules: readonly {
    readonly token: string;
    readonly foreground?: string;
    readonly fontStyle?: string;
  }[];
}

export interface MonacoNamespace {
  readonly editor: {
    create(
      container: HTMLElement,
      options: Record<string, unknown>,
    ): MonacoEditorInstance;
    defineTheme(name: string, data: EditorThemeData): void;
    setTheme(theme: string): void;
  };
  readonly languages: {
    readonly typescript: {
      readonly javascriptDefaults: {
        setCompilerOptions(options: Record<string, unknown>): void;
        addExtraLib(content: string, filePath?: string): MonacoModel;
        setDiagnosticsOptions(options: Record<string, unknown>): void;
      };
      readonly ScriptTarget: { readonly ESNext: number };
      readonly ModuleKind: { readonly ESNext: number };
      readonly ModuleResolutionKind: { readonly NodeJs: number };
    };
  };
  readonly KeyMod: { readonly CtrlCmd: number };
  readonly KeyCode: { readonly KeyS: number };
}

/** The shape a `fetch`/`fetch()`-free handler is written against. */
const ENV_DTS = `
interface FunctionEnv {
  readonly [name: string]: string | undefined;
}
interface FunctionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface FunctionHandler {
  fetch(request: Request, env: FunctionEnv, ctx: FunctionContext): Response | Promise<Response>;
}
`;

interface AmdRequire {
  (deps: readonly string[], callback: () => void): void;
  config(options: { paths: Record<string, string> }): void;
}

/**
 * `window.require(['vs/editor/editor.main'], …)` resolves its callback with
 * no argument — Monaco's own loader sets `window.monaco` as a side effect of
 * that module executing, rather than returning it, so that global is what the
 * callback below reads.
 */
function amdWindow(): { require: AmdRequire; monaco: MonacoNamespace } {
  return window as unknown as {
    require: AmdRequire;
    monaco: MonacoNamespace;
  };
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${BASE}/loader.js`;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Failed to load the Monaco loader script'));
    document.head.append(script);
  });
}

function isDarkTheme(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * `styles.css` writes every colour token once, as `light-dark(<light>,
 * <dark>)` — `getComputedStyle` hands that literal string back unresolved,
 * custom properties don't get the browser's own light-dark resolution the
 * way a used property does. So this reads the pair out with a regex and
 * picks the half the current theme wants; a token that isn't a `light-dark()`
 * (the terminal tones, which don't flip) falls through to the canvas trick,
 * which normalises any CSS colour syntax to `#rrggbb`.
 */
const LIGHT_DARK =
  /light-dark\(\s*(#[0-9a-f]{3,8})\s*,\s*(#[0-9a-f]{3,8})\s*\)/i;

function toHex6(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    let digits = trimmed.slice(1);
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .split('')
        .map((c) => c + c)
        .join('');
    }
    return `#${digits.slice(0, 6)}`;
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(trimmed);
  if (rgb) {
    const [, r, g, b] = rgb;
    return `#${[r, g, b]
      .map((n) => Math.round(Number(n)).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return trimmed;
}

function resolveToken(raw: string, dark: boolean): string {
  const trimmed = raw.trim();
  const literal = LIGHT_DARK.exec(trimmed);
  const light = literal?.[1];
  const darkHex = literal?.[2];
  if (light !== undefined && darkHex !== undefined) {
    return toHex6(dark ? darkHex : light);
  }
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx === null) return toHex6(trimmed);
  ctx.fillStyle = trimmed;
  return toHex6(ctx.fillStyle);
}

/** No leading `#` — the shape `monaco.editor.defineTheme`'s `rules` want. */
function bare(hex: string): string {
  return hex.startsWith('#') ? hex.slice(1) : hex;
}

function readTokens(dark: boolean) {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) =>
    resolveToken(style.getPropertyValue(name), dark);
  return {
    surface: get('--surface'),
    surface2: get('--surface-2'),
    ink: get('--ink'),
    ink2: get('--ink-2'),
    ink3: get('--ink-3'),
    line: get('--line'),
    lineSoft: get('--line-soft'),
    accent: get('--accent'),
    accentSoft: get('--accent-soft'),
    good: get('--good'),
    warn: get('--warn'),
  };
}

/**
 * Defines and activates the `spindrift` theme from the app's own tokens.
 * Called at load and again on every theme change, since the tokens resolve
 * to different hexes once the page's `data-theme`/OS preference flips.
 */
function applyTheme(ns: MonacoNamespace): void {
  const dark = isDarkTheme();
  const t = readTokens(dark);
  ns.editor.defineTheme('spindrift', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    colors: {
      'editor.background': t.surface,
      'editor.foreground': t.ink,
      'editorLineNumber.foreground': t.ink3,
      'editorLineNumber.activeForeground': t.ink2,
      'editorCursor.foreground': t.accent,
      'editor.selectionBackground': t.accentSoft,
      'editor.lineHighlightBackground': t.surface2,
      'editorIndentGuide.background1': t.lineSoft,
      'editorWidget.background': t.surface,
      'editorWidget.border': t.line,
      'editorSuggestWidget.background': t.surface,
      'editorSuggestWidget.selectedBackground': t.accentSoft,
      'editorHoverWidget.background': t.surface,
      'editorGutter.background': t.surface,
      'scrollbarSlider.background': `${t.line}80`,
      focusBorder: t.accent,
      'editorBracketMatch.border': t.accent,
    },
    rules: [
      { token: 'comment', foreground: bare(t.ink3), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(t.accent) },
      { token: 'string', foreground: bare(t.good) },
      { token: 'number', foreground: bare(t.warn) },
      { token: 'type', foreground: bare(t.accent) },
      { token: 'identifier', foreground: bare(t.ink) },
      { token: 'delimiter', foreground: bare(t.ink2) },
    ],
  });
  ns.editor.setTheme('spindrift');
}

/**
 * Editor options every instance in this app wants, merged underneath
 * whatever the call site passes (`FunctionEditor` still owns `value`,
 * `language` and the rest). Applied by wrapping `editor.create` rather than
 * by the caller spreading a constant in, so the theme and font stay correct
 * with no per-call-site upkeep.
 */
function installDefaultOptions(ns: MonacoNamespace): void {
  const fontFamily =
    getComputedStyle(document.body).getPropertyValue('--font-mono').trim() ||
    'ui-monospace, SFMono-Regular, Menlo, monospace';
  const defaults: Record<string, unknown> = {
    theme: 'spindrift',
    fontFamily,
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    padding: { top: 12, bottom: 12 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    tabSize: 2,
  };
  const create = ns.editor.create.bind(ns.editor);
  ns.editor.create = (container, options) =>
    create(container, { ...defaults, ...options });
}

/**
 * Configured once, the instant the namespace exists: the compiler options a
 * `fetch(request, env)` handler needs to typecheck against, the app's own
 * editor theme, and a theme listener that tracks both a `data-theme` change
 * and an OS preference change for the lifetime of the tab.
 */
function configure(ns: MonacoNamespace): void {
  const ts = ns.languages.typescript;
  ts.javascriptDefaults.setCompilerOptions({
    allowJs: true,
    checkJs: true,
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    lib: ['esnext', 'dom', 'dom.iterable'],
    noEmit: true,
  });
  ts.javascriptDefaults.addExtraLib(ENV_DTS, 'file:///functions.d.ts');

  installDefaultOptions(ns);
  applyTheme(ns);
  new MutationObserver(() => applyTheme(ns)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
    applyTheme(ns),
  );
}

let loading: Promise<MonacoNamespace> | null = null;

export async function loadMonaco(): Promise<MonacoNamespace> {
  if (loading) return loading;
  loading = loadScript().then(
    () =>
      new Promise<MonacoNamespace>((resolve) => {
        const { require } = amdWindow();
        require.config({ paths: { vs: BASE } });
        require(['vs/editor/editor.main'], () => {
          // Read now, not at the top of this executor: the loader has not
          // run `vs/editor/editor.main` yet at that point, so `window.monaco`
          // is not there to capture until this callback fires.
          const { monaco } = amdWindow();
          configure(monaco);
          resolve(monaco);
        });
      }),
  );
  return loading;
}
