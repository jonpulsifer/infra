// The console serves Monaco itself: a CDN-hosted loader would run script on the
// console's origin with the operator's session, and pull more files after it.
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BundleMissingError, monacoRoutes } from '../../src/web/bundle.ts';
import { MONACO_BASE, MONACO_VERSION } from '../../src/web/monaco-path.ts';
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

  test('serves the stylesheet and worker the loader fetches next', () => {
    const css = routes[`${MONACO_BASE}/editor/editor.main.css`];
    expect(css!.headers.get('content-type')).toStartWith('text/css');
    expect(routes[`${MONACO_BASE}/base/worker/workerMain.js`]).toBeDefined();
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
