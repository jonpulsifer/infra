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
import type { AppListItem } from '../../src/commands/views.ts';
import { PRODUCT_NAME, WORDMARK } from '../../src/web/brand.ts';
import { crumbsFor } from '../../src/web/components/breadcrumbs.tsx';
import {
  filterPalette,
  type PaletteCatalogue,
  paletteItems,
} from '../../src/web/components/command-palette.tsx';
import {
  AppShell,
  activeKey,
  DEVELOPER,
  FOOTER_SETTINGS,
  PHONE_NAV,
  WORKSPACE,
} from '../../src/web/components/shell.tsx';
import { APP_LIST, TARGET_LIST } from '../fixtures/scenarios.ts';

const OPERATOR = { id: 'operator', displayName: 'Ada Operator' };

function shell(path: string, apps?: readonly AppListItem[]): string {
  return renderToStaticMarkup(
    <AppShell
      path={path}
      principal={OPERATOR}
      apps={apps}
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

/** One minimal, valid App row, so each test only spells out what it tests. */
function app(
  overrides: Partial<AppListItem> & Pick<AppListItem, 'id' | 'name' | 'phase'>,
): AppListItem {
  return {
    target: 'Primary',
    vessel: 'vessel-a',
    url: '',
    urlLive: false,
    kind: 'service',
    source: 'example-org/infra',
    artifact: 'image · a1b2c3d4e5f6',
    ...overrides,
  };
}

describe('the shell names where it goes', () => {
  test('every rail destination is a word, not only a glyph', () => {
    const markup = shell('/builds');

    // `Apps` moved from a single static entry to a group with a live list and
    // an "All apps" fallback row (§3 of this rail's brief); the group's own
    // eyebrow still reads "Apps", so that word is covered by the group-label
    // assertion below instead of by this row-level one.
    for (const label of ['Overview', 'All apps', 'Supply chain', 'Deploys']) {
      expect(markup).toContain(`>${label}</span>`);
    }
  });

  test("each group's eyebrow names the list beneath it", () => {
    const markup = shell('/');

    for (const [id, label] of [
      ['apps', 'Apps'],
      ['workspace', 'Workspace'],
      ['developer', 'Developer'],
    ] as const) {
      expect(markup).toContain(`id="rail-group-${id}"`);
      expect(markup).toContain(`aria-labelledby="rail-group-${id}"`);
      expect(markup).toContain(`>${label}</h2>`);
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

describe('the active-entry rule: the most specific matching root wins', () => {
  const ALL = [...WORKSPACE, ...DEVELOPER, FOOTER_SETTINGS];

  test('/targets lights Targets, not Settings', () => {
    expect(activeKey('/targets', ALL)).toBe('targets');
  });

  test('/repos and /storage light Targets too — the same alias', () => {
    expect(activeKey('/repos', ALL)).toBe('targets');
    expect(activeKey('/storage', ALL)).toBe('targets');
  });

  test('the agent-tokens path lights MCP, not Settings', () => {
    expect(activeKey('/settings/identity', ALL)).toBe('mcp');
  });

  test('every other /settings section lights Settings', () => {
    for (const path of [
      '/settings/connections',
      '/settings/installation',
      '/settings/notifications',
      '/settings/danger',
    ]) {
      expect(activeKey(path, ALL)).toBe('settings');
    }
  });

  test('a path nothing claims lights nothing', () => {
    expect(activeKey('/nowhere', ALL)).toBeUndefined();
  });

  test('every entry lights itself: navigating to its own path lands on its own key', () => {
    // Settings is the one deliberate exception (its own doc comment says so):
    // its `path` defaults into Connections while its `roots` cover all of
    // `/settings`, so a bare `/settings/connections` lights it rather than a
    // more specific section. Every other entry's `path` is one of its own
    // `roots`, and this is the assertion that would have caught Targets
    // navigating to `/settings/connections` and lighting Settings instead of
    // itself.
    for (const entry of [...WORKSPACE, ...DEVELOPER]) {
      expect(activeKey(entry.path, ALL)).toBe(entry.key);
    }
  });
});

describe('the phone bar answers for every workspace destination', () => {
  // `PHONE_NAV` folds several `WORKSPACE` entries into one (Targets and MCP
  // both land on its `settings`), so this does not ask for the same key back
  // the way the desktop rail's assertion above does — only that *something*
  // lights, which is what a screen with no matching tab at all fails to do.
  // This is the assertion that would have caught Datastores and Functions
  // dropped from the phone bar with no tab left to reach either list from.
  test('every WORKSPACE root lights some phone-bar entry', () => {
    for (const entry of WORKSPACE) {
      for (const root of entry.roots) {
        expect(activeKey(root, PHONE_NAV)).toBeDefined();
      }
    }
  });
});

describe('exactly one row lights, in the desktop rail, for a sample of paths', () => {
  // The whole `<aside>` rather than only its `<nav>`: Settings is pinned in
  // the rail's footer, outside the scrollable `<nav>` on purpose (§6 of this
  // rail's brief — "pinned to the bottom"), so the one row a path lights can
  // legitimately be there instead of inside the landmark.
  function withinAside(markup: string): string {
    const start = markup.indexOf('<aside');
    return markup.slice(start, markup.indexOf('</aside>', start));
  }

  for (const path of [
    '/',
    '/targets',
    '/settings/identity',
    '/settings/connections',
    '/deploys/1187',
    '/apps/some-app',
  ]) {
    test(path, () => {
      const aside = withinAside(shell(path));
      expect(occurrences(aside, 'aria-current="page"')).toBe(1);
    });
  }
});

describe('the Apps group draws the rows it is given', () => {
  const rows: readonly AppListItem[] = [
    app({ id: 'a1', name: 'hub', phase: 'LIVE', deployId: 1 }),
    app({ id: 'a2', name: 'api', phase: 'APPLYING', deployId: 2 }),
    app({ id: 'a3', name: 'wiki', phase: 'FAILED', deployId: 3 }),
    app({ id: 'a4', name: 'stale', phase: 'LIVE', faulty: true, deployId: 4 }),
    // `deployId` absent: never deployed, the case a fallback `PENDING` alone
    // cannot tell apart from one queued for its second release.
    app({ id: 'a5', name: 'fresh', phase: 'PENDING' }),
  ];

  test('each row names its App and carries the tone its state derives to', () => {
    const markup = shell('/', rows);

    for (const row of rows) expect(markup).toContain(row.name);
    expect(markup).toContain('text-status-live');
    expect(markup).toContain('text-status-building');
    expect(markup).toContain('text-status-failed');
    // The hollow ring — a stroke rather than a fifth fill colour, for the one
    // tone that means "nothing has run yet".
    expect(markup).toContain('text-status-idle');
    expect(markup).toContain('border border-current');
  });

  test('a faulty LIVE App reads as failed, the same rule the App list pill uses', () => {
    const markup = shell('/', [
      app({
        id: 'a4',
        name: 'stale',
        phase: 'LIVE',
        faulty: true,
        deployId: 4,
      }),
    ]);
    const rowStart = markup.lastIndexOf('<button', markup.indexOf('stale'));
    const row = markup.slice(rowStart, markup.indexOf('</button>', rowStart));

    expect(row).toContain('text-status-failed');
    expect(row).not.toContain('text-status-live');
  });

  test('capped at 8, because nobody scans a ninth row in a rail', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      app({
        id: `id-${index}`,
        name: `app-${index}`,
        phase: 'LIVE',
        deployId: index,
      }),
    );
    const markup = shell('/', many);

    for (const row of many.slice(0, 8)) expect(markup).toContain(row.name);
    for (const row of many.slice(8)) expect(markup).not.toContain(row.name);
  });

  test('an absent list renders the rail without it, not broken', () => {
    // No `apps` prop: the effect that would fetch it does not run under
    // `renderToStaticMarkup`, which is also what a still-loading or a failed
    // read looks like from this component's own point of view. Either way,
    // nothing throws, and "All apps" — not data-dependent — stays reachable.
    expect(() => shell('/')).not.toThrow();
    expect(shell('/')).toContain('All apps');
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
    expect(markup).toContain(`${PRODUCT_NAME} sha256:57fa33c28109`);
  });

  test('and nothing where the deployment states none', () => {
    expect(shell('/')).not.toContain('<footer');
  });
});

describe('the crumb carries the object', () => {
  test('a detail route says which one, under the product name', () => {
    const markup = shell('/deploys/1187');

    expect(markup).toContain(`${WORDMARK} /`);
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
