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
  storeAdapterSchema,
  targetAdapterSchema,
} from '../../src/config/manifest.schema.ts';

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
]);

/**
 * The product's own namespace. A far side that takes labels or annotations
 * wants a prefix saying who wrote them, and `spindrift-…` is the same string in
 * every installation — it names the software, never the deployment of it, which
 * is exactly what §20 draws the line around.
 */
const PRODUCT_NAMESPACE = /^spindrift-/;

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
      if (imported.has(value)) continue;
      if (value.includes('/') || value.includes('.')) continue;
      if (PROJECT_ID.test(value) && NOT_A_WORD.test(value)) {
        offenders.push(`${file.path}: '${value}'`);
      }
    }
  }
  return offenders;
}

const FROM_IMPORT =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/gm;
const BARE_IMPORT = /(?:^|\s)import\s*['"]([^'"]+)['"]/gm;

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
    expect(fixture).toContain('apexZone');
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

  test('a side-effect import of an undeclared dependency', () => {
    expect(findForeignImports(dirty("import 'dotenv/config';")).length).toBe(1);
  });
});
