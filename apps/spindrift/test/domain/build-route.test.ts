/**
 * Which route builds for which Target (Task 25, §16).
 *
 * §16's rule is two clauses in one sentence and the order of them is the whole
 * design: "the level is a threshold, **then** admin rank wins". These tests are
 * mostly about that order — a threshold that behaved like a preference would
 * pass a naive test and put an L1 build on an L2 Target.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
  selectBuildRoute,
} from '../../src/domain/build-route.ts';

/** The three routes an installation has, in admin rank order. */
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
    // The whole point of a threshold: rank cannot promote a route below it.
    // §4 states the consequence outright — a Target cannot be both
    // offline-capable and require L2 or above.
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
    // The array of routes *is* the admin rank (§16). Sorting here would replace
    // an operator's arrangement with this function's opinion of one.
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
    // An installation may retire a route without editing every Target. The
    // honest reading is that the route is unavailable, which is what the
    // annotated non-candidates already say.
    const { route } = selectBuildRoute(ROUTES, { routes: ['retired'] });
    expect(route).toBeNull();
  });

  test('“nowhere can build this” is an answer with reasons, not an empty list', () => {
    // The creation flow has to be able to stop on this before a Build row
    // exists (§18's unmet prerequisite), which needs a sentence to show.
    const { route, candidates } = selectBuildRoute(
      [{ name: 'local', level: 1 }],
      { minimumLevel: 2 },
    );
    expect(route).toBeNull();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.reason).not.toBe('');
  });

  test('an installation with no routes configured is a supported installation', () => {
    // An uploaded archive of finished output consults no route at all (§4), so
    // this is a real state rather than a misconfiguration.
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
