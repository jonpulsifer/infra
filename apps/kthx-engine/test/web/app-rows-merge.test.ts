// A poll re-reads only page 1 of the Apps list, so the pages a reader loaded
// below it must survive the merge.
import { describe, expect, test } from 'bun:test';
import type {
  AppListItem,
  AppRowsView,
  AppRowView,
} from '../../src/commands/views.ts';
import { appendAppRows, mergeAppRows } from '../../src/web/views/apps/list.tsx';

function app(id: string, phase: AppListItem['phase'] = 'LIVE'): AppRowView {
  return {
    kind: 'app',
    key: id,
    app: {
      id,
      name: id,
      phase,
      target: 'kubernetes',
      vessel: 'vessel-a',
      url: '',
      urlLive: false,
      kind: 'service',
      source: 'example-org/infra',
      artifact: 'none',
    },
  };
}

function site(name: string, release: number | null = 1): AppRowView {
  return {
    kind: 'site',
    key: `site:${name}`,
    site: {
      name,
      url: `https://${name}.sites.example`,
      release,
      held: false,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  };
}

function view(
  rows: readonly AppRowView[],
  next: string | null,
  total = 99,
): AppRowsView {
  return { rows, sites: { state: 'ok', total }, next };
}

const keys = (merged: AppRowsView) => merged.rows.map((row) => row.key);

describe('mergeAppRows', () => {
  test('with only page 1 loaded, the fresh page replaces it whole', () => {
    const current = view([app('a'), site('s1'), site('s2')], 's2');
    const fresh = view([app('a'), site('s0'), site('s1')], 's1');

    const merged = mergeAppRows(fresh, current);
    expect(merged).toBe(fresh);
    expect(keys(merged)).toEqual(['a', 'site:s0', 'site:s1']);
    expect(merged.next).toBe('s1');
  });

  test('with more loaded, older sites follow the fresh page and the cursor stays', () => {
    const current = view(
      [app('a'), site('s1'), site('s2'), site('s3'), site('s4')],
      's4',
    );
    const fresh = view([app('a', 'APPLYING'), site('s1'), site('s2')], 's2');

    const merged = mergeAppRows(fresh, current);
    expect(keys(merged)).toEqual([
      'a',
      'site:s1',
      'site:s2',
      'site:s3',
      'site:s4',
    ]);
    expect(merged.next).toBe('s4');
    // Page 1's rows are the fresh ones.
    const first = merged.rows[0];
    expect(first?.kind === 'app' && first.app.phase).toBe('APPLYING');
  });

  test('a row on both pages appears once, as the fresh one', () => {
    const current = view(
      [site('s1'), site('s2', null), site('s3'), site('s4')],
      's4',
    );
    const fresh = view([site('s0'), site('s1'), site('s2', 5)], 's2');

    const merged = mergeAppRows(fresh, current);
    expect(keys(merged)).toEqual([
      'site:s0',
      'site:s1',
      'site:s2',
      'site:s3',
      'site:s4',
    ]);
    const s2 = merged.rows[2];
    expect(s2?.kind === 'site' && s2.site.release).toBe(5);
  });

  test('a fresh page that is the last page is everything there is', () => {
    const current = view([site('s1'), site('s2'), site('s3')], 's3');
    const fresh = view([site('s1')], null, 1);

    expect(mergeAppRows(fresh, current)).toBe(fresh);
  });

  test('sites that turn unreadable drop out rather than going stale', () => {
    const current = view([app('a'), site('s1'), site('s2'), site('s3')], 's3');
    const fresh: AppRowsView = {
      rows: [app('a')],
      sites: { state: 'unreadable', reason: 'kthx did not answer within 3s' },
      next: null,
    };

    expect(mergeAppRows(fresh, current)).toBe(fresh);
  });
});

describe('appendAppRows', () => {
  test('a later page follows the rows on screen and moves the cursor', () => {
    const current = view([app('a'), site('s1'), site('s2')], 's2');
    const page = view([site('s3'), site('s4')], null, 100);

    const appended = appendAppRows(current, page);
    expect(keys(appended)).toEqual([
      'a',
      'site:s1',
      'site:s2',
      'site:s3',
      'site:s4',
    ]);
    expect(appended.next).toBeNull();
    expect(appended.sites).toEqual({ state: 'ok', total: 100 });
  });

  test('a site already on screen is not listed twice', () => {
    const current = view([site('s1'), site('s2')], 's2');
    const page = view([site('s2'), site('s3')], 's3');

    expect(keys(appendAppRows(current, page))).toEqual([
      'site:s1',
      'site:s2',
      'site:s3',
    ]);
  });
});
