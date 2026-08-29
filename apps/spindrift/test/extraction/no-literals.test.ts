/**
 * The extraction contract, mechanically (spec §20).
 *
 * Line 3 of the contract — "everything naming this installation is a value in
 * the installation manifest; a literal outside it is a bug" — is a grep, and
 * this is the grep. It exists before the feature code it polices, because a
 * rule like this is never made to pass retroactively.
 *
 * The second half is the source-level discipline: no import from outside
 * `apps/spindrift/` except declared workspace dependencies, which is what makes
 * workspace pruning produce a self-contained package.
 *
 * Both scanners run twice: over the real package, where they must find nothing,
 * and over deliberately dirty synthetic files, where they must find it. A
 * detector nobody has seen fail is not a detector.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  buildRouteAdapterSchema,
  storeAdapterSchema,
  targetAdapterSchema,
} from '../../src/config/manifest.schema.ts';
import { BUILD_ROUTE_REFUSALS } from '../../src/domain/build-route.ts';
import { ARTIFACT_TYPES } from '../../src/domain/desired-state.ts';
import {
  PRESET_DEPENDENCIES,
  PRESET_VERCEL_FRAMEWORKS,
} from '../../src/domain/detection/declared.ts';
import { KUBERNETES_DELIVERY_FLAVOURS } from '../../src/domain/target.ts';
import { VESSEL_KINDS } from '../../src/domain/vessel.ts';
import { FUNCTION_TARGETS } from '../../src/functions/contract.ts';

const APP = join(import.meta.dir, '../..');

/** The one file allowed to describe installation-shaped values in prose. */
const SCHEMA = 'src/config/manifest.schema.ts';

/**
 * Literals that name the installation this repository happens to run. Matched
 * case-insensitively on word boundaries, so a hyphenated derivative such as a
 * `homelab-…` project id is caught by the bare word. Adding a value here is
 * cheap; the point is that any one of them appearing under `src/` is a bug.
 */
const INSTALLATION_LITERALS = [
  'lolwtf\\.ca',
  'pulsifer\\.ca',
  'jonpulsifer',
  'folly',
  'offsite',
  'homelab',
  'oldschool',
  'harmonia',
];

/**
 * A cloud project id: 6–30 characters, lowercase letter first, letters, digits
 * and hyphens after, and carrying at least one hyphen or digit — which is what
 * separates `sunlit-vector-4021` from an English word of the same shape. Only
 * checked inside quoted runs, because even so the shape is too common to grep
 * for in free text.
 */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NOT_A_WORD = /[-\d]/;

/**
 * Strings that match the project-id shape but are vocabulary, not identity.
 * The adapter names come from the schema itself so that adding an adapter does
 * not break a test in another directory.
 */
const PROJECT_ID_ALLOWLIST = new Set<string>([
  ...targetAdapterSchema.options,
  ...storeAdapterSchema.options,
  ...buildRouteAdapterSchema.options,
  // Delivery flavours wear the same shape and are the same kind of thing: the
  // name of a mechanism this software knows, identical in every installation.
  ...KUBERNETES_DELIVERY_FLAVOURS,
  // The tenancy boundaries a Target can sit on. `gcp-project` names a kind of
  // place, not a place: every installation with a cloud vessel has one, and the
  // project it points at is in the row rather than in this source.
  ...VESSEL_KINDS,
  // Why a build route is not usable for a Target — vocabulary again, read from
  // the domain rather than restated, so adding one does not break a test here.
  ...BUILD_ROUTE_REFUSALS,
  // The package that proves a project uses a given framework. `react-scripts`
  // wears the project-id shape and names no installation: it is the same
  // package on npm for everybody, which is exactly why detection can key on it.
  ...PRESET_DEPENDENCIES,
  // The same table's other half: the framework each preset is called in the
  // edge platform's vocabulary. `create-react-app` and `sveltekit-1` wear the
  // project-id shape and name nothing — they are `@vercel/frameworks`' own
  // slugs, the same for everybody, which is the whole reason a build can be
  // told which one it is building.
  ...PRESET_VERCEL_FRAMEWORKS,
  // The shapes a Build can produce. Vocabulary read from the domain rather
  // than restated, so adding a shape does not break a test here.
  ...ARTIFACT_TYPES,
  // An encoding, a digest algorithm, and a key in a workflow file. None of the
  // three names anything; all wear the shape because they are lowercase words
  // carrying a digit or a hyphen, which is the whole of what this scanner can
  // see. The algorithm is §16's — correlation joins on digests everywhere in
  // the supply chain, so naming the function that produces one is this
  // system's vocabulary in every installation.
  'base64',
  'sha256',
  // The POSIX utility that checks the plan generator's download, named in the
  // builder program and in the tools that program declares it needs. Same kind
  // of thing as the two above: a lowercase word carrying a digit.
  'sha256sum',
  'run-name',
  // Supply-chain posture keys and pinned tool vocabulary. These are product
  // terms identical in every installation, not cloud project identifiers.
  'source-receipt',
  'backend-provenance',
  'core-signature',
  'source-controls',
  'buildkit-provenance',
  'base-freshness',
  'target-verification',
  'platform-verdict',
  'artifact-digest',
  'sign-blob',
  // The vendor subcommand that writes an attestation. Same kind of thing as
  // the two below it: a tool's own vocabulary, identical in every installation.
  'sign-and-create',
  // The value BuildKit annotates its `provenance` and `sbom` manifests with,
  // read by the attestation step to tell an entry a runtime can run from one it
  // cannot. A registry's own vocabulary — the same string under every index
  // BuildKit has ever pushed, in every installation.
  'attestation-manifest',
  'slsa-verifier',
  'verify-image',
  'verify-signature',
  // UI logo mark name exported by build descriptor.
  'google-cloud',
  // Default infra storage bucket — the first-party source bucket declared in
  // DEFAULT_PLACEHOLDER_MANIFEST and the manifest schema fixture.
  'bluenose-spindrift-source',
  // HTTP header names. `src/web/` is scoped out of this scanner for exactly
  // this reason (see BROWSER_SOURCE), but the auth surface writes headers from
  // outside that directory and must not be scoped out wholesale — it is one of
  // the places a real installation literal could hide. Naming the specific
  // header keeps the scanner at full strength over the rest of the file.
  'set-cookie',
  // The two headers an agent token's last use is recorded from. Standard
  // header names, identical in every installation — and read on the auth
  // surface rather than in a browser bundle, which is why they are named here
  // one at a time rather than the file being scoped out.
  'x-forwarded-for',
  'user-agent',
  // The header the edge platform checks an uploaded file's integrity with.
  // Same kind of thing again: a vendor's own header name, identical for every
  // installation, written by a deploy adapter rather than by a browser bundle.
  'x-vercel-digest',
  // The header an OCI registry states its authentication challenge in. Same
  // kind of thing as the one above, read by the registry probe — which lives
  // outside `src/web/` because it is a far side rather than a browser bundle.
  'www-authenticate',
  // The fixed account name Artifact Registry takes in place of a username.
  // Vendor vocabulary: it is the same string for everybody, which is exactly
  // why the registry-credential table names it as an example of a username a
  // typo in would otherwise be undiagnosable.
  'oauth2accesstoken',
  // The two surfaces a function deploys to. Vocabulary read from the feature's
  // own contract rather than restated, so adding a surface does not break a
  // test here.
  ...FUNCTION_TARGETS,
  // A language runtime and a websocket subprotocol, both named by the platform
  // that serves them. Same kind of thing as the header names above: one string
  // for everybody, written by a deployer rather than by a browser bundle.
  'nodejs22',
  'trace-v1',
  // The headers a kthx site is served with and an upload arrives under, plus
  // the one the edge stamps a caller's address in. Standard names, written
  // outside `src/web/` because kthx answers on its own hosts rather than
  // through the browser bundle.
  'cache-control',
  'content-type',
  'x-content-type-options',
  'content-length',
  'if-none-match',
  'if-match',
  'x-filename',
  'cf-connecting-ip',
  'no-cache',
  'no-store',
]);

/**
 * The product's own namespace. A far side that takes labels or annotations
 * wants a prefix saying who wrote them, and `spindrift-…` is the same string in
 * every installation — it names the software, never the deployment of it, which
 * is exactly what §20 draws the line around.
 */
const PRODUCT_NAMESPACE = /^spindrift-/;

/**
 * An abbreviated git object id or digest prefix: hex, and nothing else.
 *
 * It wears the project-id shape exactly — `dd9b103` is a lowercase letter
 * followed by letters and digits — and it is this system's own vocabulary.
 * §16 correlates on digests everywhere in the supply chain, so a commit or a
 * digest prefix is a value Spindrift prints about anybody's code, never a name
 * for the installation printing it.
 */
const OBJECT_ID = /^[0-9a-f]{6,40}$/;

/**
 * The browser bundle's source, which the project-id scanner does not read.
 *
 * This is a deliberate narrowing, and it is worth stating why rather than
 * discovering it later. The scanner's shape test cannot distinguish a project
 * id from a lowercase hyphenated word, and **web platform vocabulary is nothing
 * but lowercase hyphenated words**: `bg-card`, `text-muted-foreground`,
 * `prefers-color-scheme`, `data-theme`, `content-type`, `same-origin`. There is
 * no lexical rule that exempts those and still catches `trusted-builds`, and no
 * positional rule either — they appear in class attributes, in variant tables,
 * in fetch options, in HTML, and in prose about all four.
 *
 * Left in place, the scanner reports dozens of findings and no bugs, which is
 * the state in which a detector gets deleted by whoever hits it next. Scoped
 * out, it keeps full strength over the code that could actually hold one: the
 * adapters, the config layer, the domain, and the reconciler.
 *
 * What still covers `src/web/`:
 *
 * - **The literal scanner, at full strength.** It is the half with teeth for
 *   §20's rule, and an installation's name inside a className is still a bug it
 *   finds. Only the shape heuristic is scoped out.
 * - **The shape of the boundary.** The browser reaches the far side through one
 *   generated dispatch surface (Task 36b) that carries command names, never
 *   endpoints or project identifiers; anything installation-specific the UI
 *   shows arrives from the manifest, which is where §20 puts it.
 *
 * An HTML document anywhere under `src/` is browser source for the same
 * reason — `src/kthx/landing.html` is nothing but class names and headers —
 * and is scoped out with it, as is the one script a kthx site loads.
 */
const BROWSER_SOURCE = (path: string): boolean =>
  path.startsWith('src/web/') ||
  path.endsWith('.html') ||
  path === 'src/kthx/sdk.js';

/** Files that are not text, and would only produce noise. */
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|pdf|zip|gz)$/i;

type SourceFile = { path: string; source: string };

const packageJson = (await Bun.file(join(APP, 'package.json')).json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DECLARED_DEPENDENCIES = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

/** Strip comments, so a file's prose can be scanned separately from its code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * What of a file gets scanned. Only the manifest schema is scanned with its
 * comments stripped: it is where installation-shaped values are described, so
 * its prose may say what a value is for. Every other file is scanned whole,
 * comments included, because a hostname in a comment is still a hostname.
 */
function scannable(file: SourceFile): string {
  return file.path === SCHEMA ? stripComments(file.source) : file.source;
}

/** Files carrying an installation-specific literal. */
function findLiterals(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const literal of INSTALLATION_LITERALS) {
    const pattern = new RegExp(`\\b${literal}\\b`, 'i');
    for (const file of files) {
      if (pattern.test(scannable(file))) {
        offenders.push(`${file.path}: /${literal}/`);
      }
    }
  }
  return offenders;
}

/**
 * Every quoted run in a file: single, double, backtick, and the bare form a JSX
 * or HTML attribute takes. Quote style is a formatter setting, so the scanner
 * must not depend on one.
 */
const QUOTED = /['"`]([^'"`\n]{6,30})['"`]/g;

/** Strings shaped like a cloud project id. */
function findProjectIds(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (BROWSER_SOURCE(file.path)) continue;
    const source = scannable(file);
    // A package name is not an identity. `drizzle-orm` and `bun-sql` wear the
    // same shape as a project id, so the file's own import specifiers are
    // exempt — and an import that names something it should not is the other
    // scanner's finding, not this one's.
    const imported = new Set(
      importSpecifiers(source).flatMap((specifier) => specifier.split('/')),
    );
    for (const [, value] of source.matchAll(QUOTED)) {
      if (!value || PROJECT_ID_ALLOWLIST.has(value)) continue;
      if (PRODUCT_NAMESPACE.test(value)) continue;
      if (OBJECT_ID.test(value)) continue;
      if (imported.has(value)) continue;
      if (value.includes('/') || value.includes('.')) continue;
      if (PROJECT_ID.test(value) && NOT_A_WORD.test(value)) {
        offenders.push(`${file.path}: '${value}'`);
      }
    }
  }
  return offenders;
}

/**
 * An import statement, and nothing that merely reads like one.
 *
 * Three narrowings, each closing a false positive this scanner produced when it
 * was looser: the statement starts a line, because that is the only place an
 * `import` may appear; the `from` clause is in the same statement, so a `;`
 * between the two ends the match; and a specifier holds no newline, because
 * none ever does. Without them, `export class Foo {` followed a hundred lines
 * later by a sentence ending in the word `from` is reported as an import of
 * everything in between.
 */
const FROM_IMPORT = /^(?:import|export)\b[^;]*?from\s*['"]([^'"\n]+)['"]/gm;
const BARE_IMPORT = /^import\s*['"]([^'"\n]+)['"]/gm;

/** Every module specifier a source imports, in either form. */
function importSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(FROM_IMPORT)].map((m) => m[1]),
    ...[...source.matchAll(BARE_IMPORT)].map((m) => m[1]),
  ].filter((s): s is string => s !== undefined);
}

/** Imports that reach outside the package or outside its declared dependencies. */
function findForeignImports(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (!/\.[jt]sx?$/.test(file.path)) continue;
    const source = stripComments(file.source);
    for (const specifier of importSpecifiers(source)) {
      const where = `${file.path}: '${specifier}'`;
      if (specifier.startsWith('.')) {
        const resolved = join(APP, file.path, '..', specifier);
        if (relative(APP, resolved).startsWith('..')) {
          offenders.push(`${where} escapes apps/spindrift/`);
        }
        continue;
      }
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
        continue;
      }
      if (specifier === 'bun') continue;
      // A subpath import such as `react-dom/client` is declared as `react-dom`.
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] ?? specifier);
      if (!DECLARED_DEPENDENCIES.has(packageName)) {
        offenders.push(`${where} is not a declared dependency`);
      }
    }
  }
  return offenders;
}

/**
 * Every text file under a directory — deliberately not an extension allowlist,
 * because the file type nobody thought to list is exactly where a literal
 * survives.
 */
async function readSource(dir: string): Promise<SourceFile[]> {
  const entries = await readdir(join(APP, dir), {
    withFileTypes: true,
    recursive: true,
  });
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !BINARY.test(path))
    .sort();
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(APP, path),
      source: await Bun.file(path).text(),
    })),
  );
}

async function readFiles(...paths: string[]): Promise<SourceFile[]> {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: await Bun.file(join(APP, path)).text(),
    })),
  );
}

/** The literal rule polices `src/`; the import rule polices the package. */
const src = await readSource('src');
const everything = [
  ...src,
  ...(await readSource('test')),
  ...(await readFiles('build.ts')),
];

describe('the real src/', () => {
  test('has source to scan', () => {
    expect(src.length).toBeGreaterThan(0);
  });

  test('names no installation', () => {
    expect(findLiterals(src)).toEqual([]);
  });

  test('holds no string shaped like a cloud project id', () => {
    expect(findProjectIds(src)).toEqual([]);
  });

  test('leaves the installation-specific values to the fixture manifest', async () => {
    const fixture = await Bun.file(
      join(APP, 'test/fixtures/installation.example.yaml'),
    ).text();
    expect(fixture).toContain('zones');
    expect(fixture).toContain('artifactsProject');
  });
});

describe('the whole package', () => {
  test('imports only relatives, builtins, and declared dependencies', () => {
    expect(findForeignImports(everything)).toEqual([]);
  });

  test('scans more than the source tree', () => {
    expect(everything.length).toBeGreaterThan(src.length);
  });
});

describe('the scanners catch a deliberately dirty file', () => {
  const dirty = (source: string, path = 'src/dirty.ts'): SourceFile[] => [
    { path, source },
  ];

  test('a hostname literal', () => {
    expect(findLiterals(dirty("const url = 'https://app.lolwtf.ca';"))).toEqual(
      ['src/dirty.ts: /lolwtf\\.ca/'],
    );
  });

  test('a cluster name, even in a comment', () => {
    expect(findLiterals(dirty('// defaults to folly\n')).length).toBe(1);
  });

  test('a hyphenated derivative of a banned word', () => {
    expect(findLiterals(dirty("const project = 'homelab-ng';")).length).toBe(1);
  });

  test('a literal in a file type nobody thought to list', () => {
    expect(
      findLiterals(dirty('# notes about folly\n', 'src/notes.md')).length,
    ).toBe(1);
  });

  test('a project id, whichever quote it wears', () => {
    for (const source of [
      "const project = 'sunlit-vector-4021';",
      'const project = "sunlit-vector-4021";',
      'const project = `sunlit-vector-4021`;',
      '<div data-project="sunlit-vector-4021" />',
    ]) {
      expect(findProjectIds(dirty(source, 'src/dirty.tsx')).length).toBe(1);
    }
  });

  test('but not a package name wearing the same shape', () => {
    expect(
      findProjectIds(dirty("import { drizzle } from 'drizzle-orm/bun-sql';")),
    ).toEqual([]);
  });

  test('but not a key in the product’s own namespace', () => {
    expect(findProjectIds(dirty("const label = 'spindrift-key';"))).toEqual([]);
  });

  test('and the namespace exemption is a prefix, not a substring', () => {
    expect(
      findProjectIds(dirty("const project = 'my-spindrift-4021';")).length,
    ).toBe(1);
  });

  test('but not an abbreviated git object id', () => {
    expect(findProjectIds(dirty("const commit = 'dd9b103';"))).toEqual([]);
  });

  test('and the object-id exemption is hex only', () => {
    expect(findProjectIds(dirty("const commit = 'dd9b103z';")).length).toBe(1);
  });

  test('but not web platform vocabulary in the browser bundle', () => {
    for (const source of [
      '<div className="bg-card" />',
      "const tone = { error: 'text-terminal-destructive' };",
      "matchMedia('prefers-color-scheme: dark')",
      "root.setAttribute('data-theme', theme)",
      "headers: { 'content-type': 'application/json' }",
    ]) {
      expect(findProjectIds(dirty(source, 'src/web/views/dirty.tsx'))).toEqual(
        [],
      );
    }
  });

  test('and the same string outside the browser bundle is still found', () => {
    expect(
      findProjectIds(dirty("const project = 'trusted-builds';")).length,
    ).toBe(1);
  });

  test('and the browser bundle still hides no installation name', () => {
    expect(
      findLiterals(
        dirty('<div className="folly-grid" />', 'src/web/views/dirty.tsx'),
      ).length,
    ).toBe(1);
  });

  test('a project id in a comment', () => {
    expect(
      findProjectIds(dirty("// defaults to 'sunlit-vector-4021'")).length,
    ).toBe(1);
  });

  test('a doc comment in a file that is not the manifest schema', () => {
    expect(findLiterals(dirty('/** the offsite cluster */')).length).toBe(1);
  });

  test('but not a doc comment in the manifest schema itself', () => {
    expect(findLiterals(dirty('/** the folly zone */', SCHEMA))).toEqual([]);
  });

  test('and not a schema-shaped filename somewhere else', () => {
    expect(
      findLiterals(dirty('/** the folly zone */', 'src/other.schema.ts'))
        .length,
    ).toBe(1);
  });

  test('an import reaching out of the package', () => {
    expect(
      findForeignImports(dirty("import { x } from '../../hub/app/x.ts';")),
    ).toEqual(["src/dirty.ts: '../../hub/app/x.ts' escapes apps/spindrift/"]);
  });

  test('an undeclared dependency', () => {
    expect(findForeignImports(dirty("import express from 'express';"))).toEqual(
      ["src/dirty.ts: 'express' is not a declared dependency"],
    );
  });

  test('but not an export followed by prose ending in the word from', () => {
    // The shape that broke the looser scanner: a declaration at column zero,
    // and further down a sentence whose last word is followed by a quote.
    const source = [
      'export class Adapter {',
      '  detail() {',
      "    return 'the repository this chart is fetched from';",
      '  }',
      '}',
    ].join('\n');
    expect(findForeignImports(dirty(source))).toEqual([]);
  });

  test('a side-effect import of an undeclared dependency', () => {
    expect(findForeignImports(dirty("import 'dotenv/config';")).length).toBe(1);
  });
});
