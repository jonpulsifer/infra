/**
 * The plan a project's *declared* dependencies imply (§5).
 *
 * §5 gives language and framework detection to "the zero-config builder", and
 * that builder is Railpack — which runs inside the BuildKit build, days of
 * wall-clock after the moment a developer is looking at a connect screen
 * waiting to be told what their repository is. So there are two questions here
 * wearing one name, and this module answers only the first:
 *
 * - **What is this?** — a `kind`, and for a website the directory its build
 *   leaves files in. Answered here, at connect time, from what the project
 *   declares about itself. Spindrift needs it before any build exists, because
 *   `kind` decides placement and placement decides the artifact's shape (§3).
 * - **How is it built?** — the command, the toolchain, the base image. Left to
 *   Railpack, which is why {@link declaredPlanner} always proposes a null
 *   `buildCommand`. Guessing one here would be a worse answer than the one the
 *   builder produces from the same files, and it would be the answer that wins.
 *
 * `outputDirectory` is the exception that proves it, and it is not Railpack's
 * to know: it is where *Spindrift* lifts files from when a website is placed on
 * a static Target (§3, story 42). No builder is asked that question, so it is
 * asked here.
 *
 * **Foreign build config is not read** (§5). `next.config.js` can turn Next.js
 * into a static export and this module will not know it — reading it means
 * evaluating somebody's JavaScript, and the surface past that is unbounded. A
 * project that exports statically says so by editing its `spindrift.yaml`,
 * which is the override §5 gives it and which wins permanently.
 */
import type { ComponentKind } from '../desired-state.ts';
import type {
  InferredComponentKind,
  KindOption,
  ZeroConfigPlan,
  ZeroConfigPlanner,
} from './ladder.ts';
import { exists, type SourceTree } from './tree.ts';

/**
 * One recognizable way of declaring what a project is.
 *
 * `outputDirectory: null` means "this renders a server, not a directory of
 * files" — it is not "unknown". A website whose output directory is null is
 * placeable as a server image and not as static files, and the placement
 * screen says so in those words rather than failing at build time.
 */
interface Preset {
  /** What a human calls it. Shown on the connect screen. */
  readonly label: string;
  /** The dependency whose presence proves it. */
  readonly dependency: string;
  readonly kind: InferredComponentKind;
  readonly outputDirectory: string | null;
  /**
   * The same identity in Vercel's vocabulary, for a Component placed on a
   * Vercel Target and built through the Build Output API.
   *
   * Here rather than in the adapter because it is the *same question this
   * table already answers* — "what is this project?" — asked in another
   * dialect, and a second table keyed on the same dependency would be a second
   * thing to keep in step.
   *
   * **Getting it wrong is silent.** `vercel build` does not auto-detect: a
   * project whose settings name no framework builds as "Other", which copies
   * the tree to `static/` and emits no functions at all. That is a green build
   * that serves an SSR app's sources — so an unrecognised project must refuse
   * to build for Vercel rather than fall back to a default.
   *
   * Slugs are `@vercel/frameworks`' own and two of them are easy to get wrong
   * from memory: modern SvelteKit is `sveltekit-1` (`sveltekit` is v0), and
   * Docusaurus v2+ is `docusaurus-2` (`docusaurus` is v1).
   */
  readonly vercelFramework: string;
}

/**
 * Ordered, most specific first: a SvelteKit app depends on `vite`, a Gatsby
 * app on `react`, and the first match wins. Reordering this changes answers.
 */
const PRESETS: readonly Preset[] = [
  {
    label: 'Next.js',
    dependency: 'next',
    kind: 'website',
    vercelFramework: 'nextjs',
    outputDirectory: null,
  },
  {
    label: 'Nuxt',
    dependency: 'nuxt',
    kind: 'website',
    vercelFramework: 'nuxtjs',
    outputDirectory: null,
  },
  {
    label: 'Remix',
    dependency: '@remix-run/dev',
    kind: 'website',
    vercelFramework: 'remix',
    outputDirectory: null,
  },
  {
    label: 'SvelteKit',
    dependency: '@sveltejs/kit',
    kind: 'website',
    vercelFramework: 'sveltekit-1',
    outputDirectory: null,
  },
  {
    label: 'Docusaurus',
    dependency: '@docusaurus/core',
    kind: 'website',
    vercelFramework: 'docusaurus-2',
    outputDirectory: 'build',
  },
  {
    label: 'Gatsby',
    dependency: 'gatsby',
    kind: 'website',
    vercelFramework: 'gatsby',
    outputDirectory: 'public',
  },
  {
    label: 'Astro',
    dependency: 'astro',
    kind: 'website',
    vercelFramework: 'astro',
    outputDirectory: 'dist',
  },
  {
    label: 'Angular',
    dependency: '@angular/cli',
    kind: 'website',
    vercelFramework: 'angular',
    outputDirectory: 'dist',
  },
  {
    label: 'Create React App',
    dependency: 'react-scripts',
    kind: 'website',
    vercelFramework: 'create-react-app',
    outputDirectory: 'build',
  },
  {
    label: 'Vue CLI',
    dependency: '@vue/cli-service',
    kind: 'website',
    vercelFramework: 'vue',
    outputDirectory: 'dist',
  },
  {
    label: 'Vite',
    dependency: 'vite',
    kind: 'website',
    vercelFramework: 'vite',
    outputDirectory: 'dist',
  },
  {
    label: 'Parcel',
    dependency: 'parcel',
    kind: 'website',
    vercelFramework: 'parcel',
    outputDirectory: 'dist',
  },
];

/**
 * The dependency each preset is recognized by.
 *
 * Exported because it is vocabulary rather than configuration — the package
 * that means "this is a Next.js app" is the same package in every installation
 * — and the literal scanner reads this list rather than carrying its own copy,
 * so adding a preset does not break a test somewhere else.
 */
export const PRESET_DEPENDENCIES: readonly string[] = PRESETS.map(
  (preset) => preset.dependency,
);

/**
 * Every framework slug this table can answer with.
 *
 * Exported for the same reason {@link PRESET_DEPENDENCIES} is: these are
 * `@vercel/frameworks`' own names, identical in every installation, and the
 * literal scanner reads this list rather than carrying its own copy.
 */
export const PRESET_VERCEL_FRAMEWORKS: readonly string[] = PRESETS.map(
  (preset) => preset.vercelFramework,
);

/**
 * The Vercel framework slug a `package.json` implies, or `null` for a project
 * no preset recognises.
 *
 * Reads the manifest rather than a tree because that is the whole of the
 * question — {@link PRESETS} is keyed on a declared dependency — and because
 * the one caller that needs this has a single file at a single commit rather
 * than a checkout. Order is {@link PRESETS}' own, so a SvelteKit app that also
 * depends on `vite` answers `sveltekit-1`.
 *
 * `null` is a refusal, not a default. See {@link Preset.vercelFramework}: a
 * Vercel build with no framework produces a static copy and no functions, so
 * the caller must fail rather than build something that looks fine and is not.
 */
export function vercelFrameworkOf(packageJson: string): string | null {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(packageJson) as PackageManifest;
  } catch {
    return null;
  }
  const declared = declaredDependencies(manifest);
  return (
    PRESETS.find((preset) => declared.has(preset.dependency))
      ?.vercelFramework ?? null
  );
}

/** A manifest file whose mere existence names a long-running process. */
const SERVICE_MANIFESTS: readonly {
  readonly file: string;
  readonly label: string;
}[] = [
  { file: 'go.mod', label: 'Go' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'Gemfile', label: 'Ruby' },
];

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

function declaredDependencies(manifest: PackageManifest): ReadonlySet<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/**
 * The disabled-with-reasons grammar (§3, §5), for one settled kind.
 *
 * Every kind stays on the list wearing why it was not chosen, because "nowhere
 * fits" and "not what I meant" are both corrections a developer makes by
 * reading rather than by guessing.
 */
function kindOptions(
  chosen: InferredComponentKind,
  because: string,
): readonly KindOption[] {
  const unavailable: Record<ComponentKind, string> = {
    service: because,
    website: because,
    job: 'jobs are asserted, never inferred',
  };
  return (['service', 'website', 'job'] as const).map((kind) =>
    kind === chosen
      ? { kind, available: true as const }
      : { kind, available: false as const, reason: unavailable[kind] },
  );
}

function joinPath(scope: string, file: string): string {
  return scope === '.' ? file : `${scope}/${file}`;
}

/**
 * A directory that already **is** a website: pages a browser opens, with
 * nothing to build first (§3, story 42).
 *
 * Asked last, and it has to be last: a Vite app has an `index.html` at its root
 * too, and what separates it from a hand-written page is the `package.json`
 * above this. Only a directory nothing else could account for gets here.
 *
 * `outputDirectory: null` is the load-bearing part rather than an omission. A
 * `files` build with no output directory ships the scope as it stands, which
 * is exactly what this is; naming one would mean the scope is the *sources* of
 * a site, sending it through the zero-config builder first — and there is
 * nothing here for that builder to build.
 */
async function planStaticFiles(
  tree: SourceTree,
  scope: string,
): Promise<ZeroConfigPlan | null> {
  if (!(await exists(tree, joinPath(scope, 'index.html')))) return null;
  return {
    outcome: 'detected',
    kind: 'website',
    reason: 'index.html — this directory already is the site',
    kinds: kindOptions('website', 'this directory is a page, not a program'),
    buildCommand: null,
    outputDirectory: null,
  };
}

async function readPackageManifest(
  tree: SourceTree,
  scope: string,
): Promise<PackageManifest | null> {
  const document = await tree.readText(joinPath(scope, 'package.json'));
  if (document === null) return null;
  try {
    return JSON.parse(document) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * Plan one scope from what it declares.
 *
 * The order is: a recognized framework, then a language manifest, then a
 * package that at least starts something, then a directory that is already a
 * site, then the honest unknown §5 insists on — "I do not know how to build
 * this" is a first-class outcome and never a silent fallback to `service`.
 */
export async function planFromDeclarations(
  tree: SourceTree,
  scope: string,
): Promise<ZeroConfigPlan> {
  const manifest = await readPackageManifest(tree, scope);

  if (manifest !== null) {
    const dependencies = declaredDependencies(manifest);
    const preset = PRESETS.find((candidate) =>
      dependencies.has(candidate.dependency),
    );
    if (preset !== undefined) {
      return {
        outcome: 'detected',
        kind: preset.kind,
        reason: `${preset.label} — \`${preset.dependency}\` is a dependency in package.json`,
        kinds: kindOptions(
          preset.kind,
          preset.outputDirectory === null
            ? `${preset.label} renders a server, not a directory of files`
            : `${preset.label} builds files into ${preset.outputDirectory}`,
        ),
        buildCommand: null,
        outputDirectory: preset.outputDirectory,
      };
    }

    if (manifest.scripts?.start !== undefined) {
      return {
        outcome: 'detected',
        kind: 'service',
        reason: 'package.json declares a start script and no known frontend',
        kinds: kindOptions(
          'service',
          'nothing here builds a directory of files to serve',
        ),
        buildCommand: null,
        outputDirectory: null,
      };
    }

    return (
      (await planStaticFiles(tree, scope)) ?? {
        outcome: 'unsupported',
        detail:
          'package.json declares no framework Spindrift recognizes and no start script. Add a `spindrift.yaml` naming the kind, or a Dockerfile.',
      }
    );
  }

  for (const { file, label } of SERVICE_MANIFESTS) {
    if (await exists(tree, joinPath(scope, file))) {
      return {
        outcome: 'detected',
        kind: 'service',
        reason: `${label} — ${file} is in this directory`,
        kinds: kindOptions(
          'service',
          `${label} projects build a program, not a directory of files`,
        ),
        buildCommand: null,
        outputDirectory: null,
      };
    }
  }

  return (
    (await planStaticFiles(tree, scope)) ?? {
      outcome: 'unsupported',
      detail:
        'no index.html, package.json, go.mod, Cargo.toml, pyproject.toml, requirements.txt or Gemfile in this directory.',
    }
  );
}

/** {@link planFromDeclarations}, as the seam the ladder takes. */
export function declaredPlanner(): ZeroConfigPlanner {
  return { plan: planFromDeclarations };
}
