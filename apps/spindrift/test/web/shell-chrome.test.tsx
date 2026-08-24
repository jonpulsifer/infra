/**
 * The chrome every screen in the product is rendered inside.
 *
 * These are claims about the frame rather than about any one screen: that the
 * rail names its destinations instead of only drawing them, that the two
 * navigations a document carries are distinguishable to anything reading
 * landmarks, that the crumb answers "which object is this" and not "what kind
 * of object is this", and that the palette's catalogue is built from the rows
 * the installation actually has.
 *
 * `renderToStaticMarkup` throughout, and the two pure functions called
 * directly. The shell holds a `localStorage` preference, a `navigator` sniff
 * and a keydown listener, none of which exist in a server render — which is the
 * point: this file is also the proof that none of that runs at module scope or
 * during the first paint.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { crumbsFor } from '../../src/web/components/breadcrumbs.tsx';
import {
  filterPalette,
  type PaletteCatalogue,
  paletteItems,
} from '../../src/web/components/command-palette.tsx';
import { AppShell } from '../../src/web/components/shell.tsx';
import { APP_LIST, TARGET_LIST } from '../fixtures/scenarios.ts';

const OPERATOR = { id: 'operator', displayName: 'Ada Operator' };

function shell(path: string): string {
  return renderToStaticMarkup(
    <AppShell
      path={path}
      principal={OPERATOR}
      onNavigate={() => undefined}
      onSignOut={() => undefined}
      themeControl={<span>theme</span>}
    >
      <p>screen</p>
    </AppShell>,
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('the shell names where it goes', () => {
  test('every rail destination is a word, not only a glyph', () => {
    const markup = shell('/builds');

    for (const label of ['Overview', 'Apps', 'Supply chain', 'Deploys']) {
      expect(markup).toContain(`>${label}</span>`);
    }
  });

  test('the two navigations are two landmarks with two names', () => {
    const markup = shell('/');

    expect(occurrences(markup, 'aria-label="Primary navigation"')).toBe(1);
    expect(
      occurrences(markup, 'aria-label="Primary navigation (compact)"'),
    ).toBe(1);
  });

  test('the operator is a control, not a title attribute', () => {
    const markup = shell('/');

    expect(markup).toContain('aria-label="Account: Ada Operator"');
    // Both things the menu exists to reach.
    expect(markup).toContain('Identity and passkeys');
    expect(markup).toContain('Sign out');
  });

  test('results have somewhere to land on every screen', () => {
    expect(shell('/')).toContain('aria-label="Recent results"');
  });
});

describe('the footer says what is running', () => {
  test('the version the deployment states, verbatim', () => {
    // Digest-pinned delivery rolls pods without a version anybody typed; this
    // line is how a browser tells which image it is talking to.
    const markup = renderToStaticMarkup(
      <AppShell
        path="/"
        principal={OPERATOR}
        version="sha256:57fa33c28109"
        onNavigate={() => undefined}
        onSignOut={() => undefined}
        themeControl={<span>theme</span>}
      >
        <p>screen</p>
      </AppShell>,
    );

    expect(markup).toContain('<footer');
    expect(markup).toContain('Spindrift sha256:57fa33c28109');
  });

  test('and nothing where the deployment states none', () => {
    expect(shell('/')).not.toContain('<footer');
  });
});

describe('the crumb carries the object', () => {
  test('a detail route says which one, under the product name', () => {
    const markup = shell('/deploys/1187');

    expect(markup).toContain('SPINDRIFT /');
    expect(markup).toContain('#1187');
  });

  test('an App is named, where the header used to say only "Apps"', () => {
    expect(crumbsFor('/apps/morrow')).toEqual([
      { label: 'Apps', path: '/apps' },
      { label: 'morrow' },
    ]);
  });

  test('the last crumb is never a link to the page already open', () => {
    for (const path of ['/', '/builds', '/builds/42', '/settings/identity']) {
      expect(crumbsFor(path).at(-1)?.path).toBeUndefined();
    }
  });

  test('the three roots that became Settings sections say so', () => {
    expect(crumbsFor('/repos')).toEqual([
      { label: 'Settings', path: '/settings/connections' },
      { label: 'Connections' },
    ]);
  });
});

describe('the palette searches what the installation has', () => {
  const catalogue: PaletteCatalogue = {
    apps: APP_LIST,
    builds: [],
    deploys: [],
    targets: TARGET_LIST,
  };

  test('with nothing read yet it still navigates', () => {
    const items = paletteItems(null);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.group === 'Go to')).toBe(true);
  });

  test('loaded rows become entries', () => {
    const labels = paletteItems(catalogue).map((item) => item.label);

    for (const app of APP_LIST) expect(labels).toContain(app.name);
  });

  test('a Target is vessel/adapter, because neither names it alone', () => {
    const targets = paletteItems(catalogue).filter(
      (item) => item.group === 'Targets',
    );

    expect(targets.length).toBe(TARGET_LIST.length);
    for (const target of TARGET_LIST) {
      expect(targets.map((item) => item.label)).toContain(
        `${target.vessel}/${target.adapter}`,
      );
    }
  });

  test('a literal hit outranks a subsequence one', () => {
    const items = paletteItems(catalogue);
    const [first] = filterPalette(items, 'wiki');

    expect(first?.label).toBe('wiki');
  });

  test('the list is capped, because nobody reads the thirteenth row', () => {
    expect(filterPalette(paletteItems(catalogue), '').length).toBeLessThan(13);
  });

  test('a query that matches nothing matches nothing', () => {
    expect(filterPalette(paletteItems(catalogue), 'zzzzzz')).toEqual([]);
  });
});
