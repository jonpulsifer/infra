/**
 * The Functions Framework shim.
 *
 * It is a string this app never runs, so the one thing worth checking here is
 * that it is a string somebody else *can* run: valid ESM, and a manifest that
 * names the file it points at.
 */
import { describe, expect, test } from 'bun:test';
import { packageJson, SHIM } from '../../src/functions/shim.ts';

describe('SHIM', () => {
  test('parses as an ES module', () => {
    expect(() =>
      new Bun.Transpiler({ loader: 'js' }).transformSync(SHIM),
    ).not.toThrow();
  });

  test('registers the entry point the build config declares', () => {
    expect(SHIM).toContain("ff.http('fn'");
    expect(SHIM).toContain("import handler from './index.mjs'");
  });
});

describe('packageJson', () => {
  test('names the function and the framework it is built against', () => {
    const manifest = JSON.parse(packageJson('fn-demo')) as Record<
      string,
      unknown
    >;
    expect(manifest.name).toBe('fn-demo');
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('shim.mjs');
    expect(manifest.dependencies).toEqual({
      '@google-cloud/functions-framework': '^5',
    });
  });
});
