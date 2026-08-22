/**
 * The Function editor's snippet catalogue: unique, described, and valid JS
 * once dropped into the placement it claims.
 */
import { describe, expect, test } from 'bun:test';
import { SNIPPETS } from '../../src/web/views/functions/snippets.ts';

function wrap(snippet: (typeof SNIPPETS)[number]): string {
  return snippet.placement === 'top'
    ? `${snippet.code}\nexport default { async fetch(request, env) { return new Response(); } };`
    : `export default { async fetch(request, env) {\n${snippet.code}\n} };`;
}

describe('SNIPPETS', () => {
  test('every id is unique', () => {
    const ids = SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every entry has a non-empty label and description', () => {
    for (const snippet of SNIPPETS) {
      expect(snippet.label.length).toBeGreaterThan(0);
      expect(snippet.description.length).toBeGreaterThan(0);
    }
  });

  test('every snippet transpiles as valid JS in its placement', () => {
    for (const snippet of SNIPPETS) {
      expect(() =>
        new Bun.Transpiler({ loader: 'js' }).transformSync(wrap(snippet)),
      ).not.toThrow();
    }
  });
});
