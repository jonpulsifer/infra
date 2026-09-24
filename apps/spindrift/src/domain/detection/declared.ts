/**
 * The kind a project's declared dependencies imply, answered at connect time.
 * The build command is left to the zero-config builder, and foreign build
 * config such as `next.config.js` is never evaluated.
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
 * A null `outputDirectory` means the preset renders a server, so it places as an
 * image and never as static files.
 */
interface Preset {
  /** Shown on the connect screen. */
  readonly label: string;
  readonly dependency: string;
  readonly kind: InferredComponentKind;
  readonly outputDirectory: string | null;
  /**
   * The `@vercel/frameworks` slug. `vercel build` does not detect one, and with
   * none it serves an SSR app's sources, so an unknown project must refuse.
   */
  readonly vercelFramework: string;
}

/** Most specific first, because the first match wins: a SvelteKit app also depends on `vite`. */
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
    // The unsuffixed slug is SvelteKit v0.
    vercelFramework: 'sveltekit-1',
    outputDirectory: null,
  },
  {
    label: 'Docusaurus',
    dependency: '@docusaurus/core',
    kind: 'website',
    // The unsuffixed slug is Docusaurus v1.
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

/** Exported so the literal scanner allowlists these package names. */
export const PRESET_DEPENDENCIES: readonly string[] = PRESETS.map(
  (preset) => preset.dependency,
);

/** Exported so the literal scanner allowlists these slugs. */
export const PRESET_VERCEL_FRAMEWORKS: readonly string[] = PRESETS.map(
  (preset) => preset.vercelFramework,
);

/** Null is a refusal: a Vercel build with no framework serves sources and no functions. */
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

/** Every kind stays listed with the reason it was not chosen, so a developer can correct it. */
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
 * Asked last, because a Vite app also has a root `index.html`. A null output
 * directory ships the scope as it stands, with no builder.
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
 * A framework, then a language manifest, then a start script, then static files.
 * Unknown is an answer, never a fallback to `service`.
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

export function declaredPlanner(): ZeroConfigPlanner {
  return { plan: planFromDeclarations };
}
