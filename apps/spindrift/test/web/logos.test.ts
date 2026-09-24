// Importing the logo barrel is most of the test: a renamed or deleted SVG
// fails at module load.
import { expect, test } from 'bun:test';
import { type LogoName, logos } from '../../src/web/client/logos/index.ts';

test('every logo resolves to an svg url', () => {
  const names = Object.keys(logos) as LogoName[];
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(logos[name]).toMatch(/\.svg$/);
  }
});
