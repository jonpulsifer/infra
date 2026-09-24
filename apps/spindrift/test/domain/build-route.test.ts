import { describe, expect, test } from 'bun:test';
import {
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
  selectBuildRoute,
} from '../../src/domain/build-route.ts';

/** In admin rank order. */
const ROUTES = [
  { name: 'local', level: 1 as const },
  { name: 'hosted', level: 2 as const },
  { name: 'cloud', level: 3 as const },
];

describe('build route selection', () => {
  test('the default minimum is L2, which is what excludes the in-cluster route', () => {
    expect(DEFAULT_MINIMUM_BUILD_LEVEL).toBe(2);

    const { route, candidates } = selectBuildRoute(ROUTES);
    expect(route).toBe('hosted');

    const local = candidates.find((candidate) => candidate.route === 'local');
    expect(local?.eligible).toBe(false);
    expect(local?.reason).toContain('L2');
  });

  test('an L2+ Target refuses in-cluster even when it is ranked first', () => {
    const { route } = selectBuildRoute(ROUTES, { minimumLevel: 2 });
    expect(route).not.toBe('local');
  });

  test('an L1 Target takes the highest-ranked route, not the highest level', () => {
    const { route } = selectBuildRoute(ROUTES, { minimumLevel: 1 });
    expect(route).toBe('local');
  });

  test('an L3 Target takes the only route that clears the bar', () => {
    const { route, candidates } = selectBuildRoute(ROUTES, { minimumLevel: 3 });
    expect(route).toBe('cloud');
    expect(candidates.filter((candidate) => candidate.eligible)).toHaveLength(
      1,
    );
  });

  test('rank is the input’s order and is never re-sorted', () => {
    const reversed = [...ROUTES].reverse();
    expect(buildRouteCandidates(reversed).map((c) => c.route)).toEqual([
      'cloud',
      'hosted',
      'local',
    ]);
    expect(selectBuildRoute(reversed, { minimumLevel: 1 }).route).toBe('cloud');
  });

  test('a Target that narrows the list gets only what it admits', () => {
    const { route, candidates } = selectBuildRoute(ROUTES, {
      minimumLevel: 1,
      routes: ['cloud'],
    });
    expect(route).toBe('cloud');
    expect(
      candidates.find((candidate) => candidate.route === 'hosted')?.reason,
    ).toContain('does not admit');
  });

  test('a Target naming a route that is gone is not an error', () => {
    // A route can be retired without editing every Target that names it.
    const { route } = selectBuildRoute(ROUTES, { routes: ['retired'] });
    expect(route).toBeNull();
  });

  test('“nowhere can build this” is an answer with reasons, not an empty list', () => {
    // The creation flow shows this reason before any Build row exists.
    const { route, candidates } = selectBuildRoute(
      [{ name: 'local', level: 1 }],
      { minimumLevel: 2 },
    );
    expect(route).toBeNull();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.reason).not.toBe('');
  });

  test('an installation with no routes configured is a supported installation', () => {
    // An uploaded archive of finished output needs no route.
    expect(selectBuildRoute([]).route).toBeNull();
    expect(selectBuildRoute([]).candidates).toEqual([]);
  });

  test('an eligible route carries no reason, and an ineligible one always does', () => {
    for (const candidate of buildRouteCandidates(ROUTES)) {
      expect(candidate.reason === '').toBe(candidate.eligible);
    }
  });

  test('selects the first available eligible route rather than stopping at an unavailable top-ranked route', () => {
    const isAvailable = (name: string) => name === 'cloud';
    const { route } = selectBuildRoute(
      ROUTES,
      { minimumLevel: 2 },
      isAvailable,
    );
    expect(route).toBe('cloud');
  });
});
