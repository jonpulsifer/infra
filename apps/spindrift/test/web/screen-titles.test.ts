/**
 * `titleOf` mirrors `Screen`'s route table branch for branch — the tab must
 * name what the screen shows. These pin the mapping for every branch,
 * including the aliases that land on Settings and the bare `/name` workspace
 * fallback.
 */
import { describe, expect, test } from 'bun:test';
import { titleOf } from '../../src/web/app.tsx';

describe('titleOf', () => {
  test.each([
    ['/', 'Spindrift'],
    ['', 'Spindrift'],
    ['/apps', 'Apps · Spindrift'],
    ['/apps/hub', 'hub · Spindrift'],
    ['/hub', 'hub · Spindrift'],
    ['/apps/new', 'New App · Spindrift'],
    ['/apps/new/7', 'New App · Spindrift'],
    ['/deploys', 'Deploys · Spindrift'],
    ['/deploys/42', 'Deploy #42 · Spindrift'],
    ['/builds', 'Builds · Spindrift'],
    ['/builds/9', 'Build #9 · Spindrift'],
    ['/sources', 'Sources · Spindrift'],
    ['/artifacts', 'Artifacts · Spindrift'],
    ['/datastores', 'Datastores · Spindrift'],
    ['/settings', 'Settings · Spindrift'],
    ['/settings/connections', 'Settings · Spindrift'],
    ['/targets', 'Settings · Spindrift'],
    ['/repos', 'Settings · Spindrift'],
    ['/storage', 'Settings · Spindrift'],
  ])('%s → %s', (path, title) => {
    expect(titleOf(path)).toBe(title);
  });
});
