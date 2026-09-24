/**
 * Shipped source may not name this installation or hold a cloud project id, and
 * nothing may import outside the package and its declared dependencies.
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

/** Matched case-insensitively on word boundaries, so derivatives match too. */
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

// A cloud project id. Requiring a hyphen or digit tells it from an English
// word, and only quoted runs are checked since the shape is common in prose.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NOT_A_WORD = /[-\d]/;

// Project-id-shaped vocabulary, the same in every installation. Lists come
// from the source so a new entry needs no edit here.
const PROJECT_ID_ALLOWLIST = new Set<string>([
  ...targetAdapterSchema.options,
  ...storeAdapterSchema.options,
  ...buildRouteAdapterSchema.options,
  ...KUBERNETES_DELIVERY_FLAVOURS,
  ...VESSEL_KINDS,
  ...BUILD_ROUTE_REFUSALS,
  ...PRESET_DEPENDENCIES,
  ...PRESET_VERCEL_FRAMEWORKS,
  ...ARTIFACT_TYPES,
  // An encoding, a digest algorithm, a checksum utility and a workflow key.
  'base64',
  'sha256',
  'sha256sum',
  'run-name',
  // Supply-chain posture keys and signing tool vocabulary.
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
  'sign-and-create',
  // BuildKit's reference type for attestations, then verifier tool names.
  'attestation-manifest',
  'slsa-verifier',
  'verify-image',
  'verify-signature',
  // A logo mark name.
  'google-cloud',
  // The source bucket in DEFAULT_PLACEHOLDER_MANIFEST.
  'bluenose-spindrift-source',
  // Header names used outside src/web/, listed one at a time so the rest of
  // each file stays scanned.
  'set-cookie',
  'x-forwarded-for',
  'user-agent',
  'x-vercel-digest',
  'www-authenticate',
  // The fixed username Artifact Registry takes with an access token.
  'oauth2accesstoken',
  // A header name in packages/archive, which is scanned as shipped source.
  'content-length',
  ...FUNCTION_TARGETS,
  // A platform's language runtime and websocket subprotocol names.
  'nodejs22',
  'trace-v1',
]);

/** The product's own label prefix, the same in every installation. */
const PRODUCT_NAMESPACE = /^spindrift-/;

/** An abbreviated commit or digest prefix, which has the project-id shape. */
const OBJECT_ID = /^[0-9a-f]{6,40}$/;

// The project-id scan skips browser source, where web vocabulary is all
// lowercase hyphenated words. The literal scan still covers it.
const BROWSER_SOURCE = (path: string): boolean =>
  path.startsWith('src/web/') || path.endsWith('.html');

const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|pdf|zip|gz)$/i;

const NOT_SOURCE = /\/(node_modules|\.turbo)\//;

type SourceFile = { path: string; source: string };

const packageJson = (await Bun.file(join(APP, 'package.json')).json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DECLARED_DEPENDENCIES = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Comments are scanned everywhere except the manifest schema, whose prose
// describes installation-shaped values.
function scannable(file: SourceFile): string {
  return file.path === SCHEMA ? stripComments(file.source) : file.source;
}

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

/** Any quote style, since quote style is a formatter setting. */
const QUOTED = /['"`]([^'"`\n]{6,30})['"`]/g;

function findProjectIds(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (BROWSER_SOURCE(file.path)) continue;
    const source = scannable(file);
    // Import specifiers are package names, which the import scan polices.
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

// Anchored at line start, stopped by a semicolon and newline-free in the
// specifier, so a class followed by prose ending in "from" is not an import.
const FROM_IMPORT = /^(?:import|export)\b[^;]*?from\s*['"]([^'"\n]+)['"]/gm;
const BARE_IMPORT = /^import\s*['"]([^'"\n]+)['"]/gm;

function importSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(FROM_IMPORT)].map((m) => m[1]),
    ...[...source.matchAll(BARE_IMPORT)].map((m) => m[1]),
  ].filter((s): s is string => s !== undefined);
}

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

/** No extension allowlist: an unlisted file type is where a literal hides. */
async function readSource(dir: string): Promise<SourceFile[]> {
  const entries = await readdir(join(APP, dir), {
    withFileTypes: true,
    recursive: true,
  });
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !BINARY.test(path) && !NOT_SOURCE.test(path))
    .sort();
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(APP, path),
      source: await Bun.file(path).text(),
    })),
  );
}

/** A workspace package's source, minus the tests the image does not serve. */
async function packageSource(dir: string): Promise<SourceFile[]> {
  return (await readSource(dir)).filter(
    (file) => !/\.test\.tsx?$/.test(file.path),
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

// The literal scans cover what the image ships; the import scan covers this
// package alone.
const src = await readSource('src');
const shipped = [...src, ...(await packageSource('../../packages/archive'))];
const everything = [
  ...src,
  ...(await readSource('test')),
  ...(await readFiles('build.ts')),
];

describe('the shipped source', () => {
  test('has source to scan', () => {
    expect(src.length).toBeGreaterThan(0);
    expect(shipped.length).toBeGreaterThan(src.length);
  });

  test('names no installation', () => {
    expect(findLiterals(shipped)).toEqual([]);
  });

  test('holds no string shaped like a cloud project id', () => {
    expect(findProjectIds(shipped)).toEqual([]);
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
