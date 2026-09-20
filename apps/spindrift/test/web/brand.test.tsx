import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MACHINE_NAME,
  PRODUCT_NAME,
  pageTitle,
  WORDMARK,
  WORDMARK_GLYPH,
} from '../../src/web/brand.ts';
import { Wordmark } from '../../src/web/components/wordmark.tsx';

// Every other test reads the name from the module, so this is the one place
// the words themselves are pinned.
test('the name, as each surface spells it', () => {
  expect(PRODUCT_NAME).toBe('Spindrift');
  expect(WORDMARK).toBe('SPINDRIFT');
  expect(WORDMARK_GLYPH).toBe('S');
  expect(MACHINE_NAME).toBe('spindrift');
});

describe('pageTitle', () => {
  test('the root is the product alone', () => {
    expect(pageTitle()).toBe(PRODUCT_NAME);
  });

  test('a page leads and the product follows', () => {
    expect(pageTitle('Apps')).toBe(`Apps · ${PRODUCT_NAME}`);
  });
});

describe('Wordmark', () => {
  test('draws the word and leaves its setting to the caller', () => {
    expect(renderToStaticMarkup(<Wordmark className="font-mono" />)).toBe(
      `<span class="font-mono">${WORDMARK}</span>`,
    );
  });
});
