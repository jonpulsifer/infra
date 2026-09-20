/**
 * `titleOf` mirrors `Screen`'s route table branch for branch — the tab must
 * name what the screen shows. These pin the mapping for every branch,
 * including the aliases that land on Settings and the bare `/name` workspace
 * fallback.
 */
import { describe, expect, test } from 'bun:test';
import { titleOf } from '../../src/web/app.tsx';
import { PRODUCT_NAME } from '../../src/web/brand.ts';

describe('titleOf', () => {
  test.each([
    ['/', undefined],
    ['', undefined],
    ['/apps', 'Apps'],
    ['/apps/hub', 'hub'],
    ['/hub', 'hub'],
    ['/apps/new', 'New App'],
    ['/apps/new/7', 'New App'],
    ['/deploys', 'Deploys'],
    ['/deploys/42', 'Deploy #42'],
    ['/builds', 'Builds'],
    ['/builds/9', 'Build #9'],
    ['/sources', 'Sources'],
    ['/artifacts', 'Artifacts'],
    ['/datastores', 'Datastores'],
    ['/settings', 'Settings'],
    ['/settings/connections', 'Settings'],
    ['/targets', 'Settings'],
    ['/repos', 'Settings'],
    ['/storage', 'Settings'],
  ])('%s → %s', (path, page) => {
    expect(titleOf(path)).toBe(
      page === undefined ? PRODUCT_NAME : `${page} · ${PRODUCT_NAME}`,
    );
  });
});
