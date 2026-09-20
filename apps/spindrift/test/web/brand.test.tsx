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
  expect(PRODUCT_NAME).toBe('kthx');
  expect(WORDMARK).toBe('kthx');
  expect(WORDMARK_GLYPH).toBe('k');
  // The machine name is a protocol identifier, deliberately untouched by the
  // brand a person reads.
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
  test('the rail setting: compact mono, tight tracking, the caller’s class', () => {
    const markup = renderToStaticMarkup(
      <Wordmark setting="rail" className="truncate" />,
    );
    expect(markup).toContain('font-mono');
    expect(markup).toContain('text-[15px]');
    // `font-medium` (500), not `font-semibold` (600) — DM Mono is only imported
    // at 400 and 500, and 600 is a browser-synthesized faux bold rather than
    // a real cut of the face.
    expect(markup).toContain('font-medium');
    expect(markup).toContain('tracking-tight');
    expect(markup).toContain('truncate');
    // Never the hero's display face or its clamp.
    expect(markup).not.toContain('font-display');
  });

  test('the hero setting: the display face, upper-case, no inherited 0.25em tracking', () => {
    const markup = renderToStaticMarkup(<Wordmark setting="hero" />);
    expect(markup).toContain('font-display');
    expect(markup).toContain('uppercase');
    expect(markup).toContain('font-black');
    expect(markup).toContain('tracking-display');
    expect(markup).not.toContain('tracking-[0.25em]');
    expect(markup).not.toContain('font-mono');
  });

  test('the underscore is decorative pink; the word alone is what a reader is left to name it by', () => {
    const markup = renderToStaticMarkup(<Wordmark setting="rail" />);
    // The word is a plain text node ahead of the hidden underscore, not
    // wrapped in anything a screen reader would skip.
    expect(markup).toMatch(
      new RegExp(`>${WORDMARK}<span aria-hidden="true"[^>]*>_</span>`),
    );
    expect(markup).toContain('text-brand');
  });
});
