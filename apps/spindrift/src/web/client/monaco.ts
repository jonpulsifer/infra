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

export interface MonacoEditorInstance {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeModelContent(listener: () => void): MonacoModel;
  updateOptions(options: Record<string, unknown>): void;
  layout(dimension?: { readonly width: number; readonly height: number }): void;
  addCommand(keybinding: number, handler: () => void): void;
  dispose(): void;
}

export interface MonacoNamespace {
  readonly editor: {
    create(
      container: HTMLElement,
      options: Record<string, unknown>,
    ): MonacoEditorInstance;
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

function themeName(): 'vs-dark' | 'vs' {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light') return 'vs';
  if (attr === 'dark') return 'vs-dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
}

/**
 * Configured once, the instant the namespace exists: the compiler options a
 * `fetch(request, env)` handler needs to typecheck against, and a theme that
 * tracks `data-theme` for the lifetime of the tab rather than only at load.
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

  ns.editor.setTheme(themeName());
  new MutationObserver(() => ns.editor.setTheme(themeName())).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] },
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
