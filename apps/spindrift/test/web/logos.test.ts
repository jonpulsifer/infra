/**
 * The logo barrel resolves every mark it names.
 *
 * Importing the module is most of the test: a renamed or deleted SVG is a
 * resolution failure at module load, not a runtime `undefined`. The assertions
 * cover the other half — that each entry came back as a URL Bun's file loader
 * produced, rather than an empty string a mistyped loader config would give.
 */
import { expect, test } from 'bun:test';
import { type LogoName, logos } from '../../src/web/client/logos/index.ts';

test('every logo resolves to an svg url', () => {
  const names = Object.keys(logos) as LogoName[];
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(logos[name]).toMatch(/\.svg$/);
  }
});
