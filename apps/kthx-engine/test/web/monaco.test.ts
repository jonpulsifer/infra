// The console serves Monaco itself: a CDN-hosted loader would run script on the
// console's origin with the operator's session, and pull more files after it.
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BundleMissingError, monacoRoutes } from '../../src/web/bundle.ts';
import {
  MONACO_BASE,
  MONACO_VERSION,
  monacoLoaderBase,
} from '../../src/web/monaco-path.ts';
import { monacoSource } from '../../src/web/monaco-source.ts';

const APP = join(import.meta.dir, '../..');

const source = await monacoSource();
const routes = await monacoRoutes(source);

// The console shares its host with kthx, which owns these first segments.
const KTHX_SEGMENTS = ['api', 'cli'];

describe('the Monaco version', () => {
  test('is the one package.json pins exactly', async () => {
    const pkg = await Bun.file(join(APP, 'package.json')).json();
    expect(pkg.devDependencies['monaco-editor']).toBe(MONACO_VERSION);
    expect(MONACO_BASE).toContain(`/${MONACO_VERSION}/`);
  });
});

describe('the served Monaco tree', () => {
  test('serves the AMD loader as JavaScript, cached for good', async () => {
    const loader = routes[`${MONACO_BASE}/loader.js`];
    expect(loader).toBeInstanceOf(Response);
    const response = loader!.clone();
    expect(response.headers.get('content-type')).toStartWith('text/javascript');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(await response.text()).toContain('define');
  });

  test('serves the stylesheet and every worker a module asks the loader for', async () => {
    const css = routes[`${MONACO_BASE}/editor/editor.main.css`];
    expect(css!.headers.get('content-type')).toStartWith('text/css');

    // Worker names are content-hashed, so read them from the `toUrl` calls.
    const referenced: string[] = [];
    for (const [path, response] of Object.entries(routes)) {
      if (!path.endsWith('.js')) continue;
      const text = await response.clone().text();
      for (const [, ref] of text.matchAll(/toUrl\("(\.\.?\/[^"]+)"\)/g)) {
        referenced.push(new URL(ref!, `http://console${path}`).pathname);
      }
    }
    expect(referenced).toContainEqual(
      expect.stringMatching(/\/assets\/ts\.worker-[\w-]+\.js$/),
    );
    for (const path of referenced) expect(routes[path]).toBeDefined();
  });

  test('has one route per file, all under its versioned base', async () => {
    const entries = await readdir(source, {
      withFileTypes: true,
      recursive: true,
    });
    const paths = Object.keys(routes);
    expect(paths).toHaveLength(entries.filter((e) => e.isFile()).length);
    for (const path of paths) {
      expect(path.startsWith(`${MONACO_BASE}/`)).toBe(true);
      expect(KTHX_SEGMENTS).not.toContain(path.split('/')[1]);
    }
  });

  test('a tree with no loader is a named failure at boot', async () => {
    await expect(monacoRoutes(join(APP, 'no-monaco-here'))).rejects.toThrow(
      BundleMissingError,
    );
  });

  test('an unreadable tree surfaces its own error', async () => {
    const error = await monacoRoutes(join(APP, 'package.json')).catch(
      (cause: unknown) => cause,
    );
    expect(error).not.toBeInstanceOf(BundleMissingError);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOTDIR');
  });
});

// Monaco starts each worker from a `blob:` URL, which no origin-less path
// resolves against, so the language workers fail to load without the origin.
describe('the loader base', () => {
  test('carries the origin', () => {
    expect(monacoLoaderBase('https://console.example')).toBe(
      `https://console.example${MONACO_BASE}`,
    );
  });

  test('is what the client hands the AMD loader', async () => {
    const client = await Bun.file(join(APP, 'src/web/client/monaco.ts')).text();
    expect(client).toContain('vs: monacoLoaderBase(location.origin)');
  });
});

describe('the client source', () => {
  test('references no CDN', async () => {
    const entries = await readdir(join(APP, 'src'), {
      withFileTypes: true,
      recursive: true,
    });
    const offenders: string[] = [];
    for (const entry of entries.filter((e) => e.isFile())) {
      const path = join(entry.parentPath, entry.name);
      if ((await Bun.file(path).text()).includes('cdn.jsdelivr.net')) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
