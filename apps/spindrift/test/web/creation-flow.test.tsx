/**
 * The creation flow's one hard rule (Task 38): **an unmet prerequisite stops
 * before any Build exists**, keeps the draft, and names the remediation path.
 *
 * Two halves, and both matter. `blockersFor` decides — it is ordinary logic and
 * is tested as such. The screen then has to *show* the decision: a disabled
 * button with no sentence beside it is the failure mode this rule exists to
 * prevent, because it leaves the developer with nothing to act on.
 *
 * **Not tested here, because it is not built:** the draft is client state, so
 * Task 38's "a browser refresh mid-flow must not lose it" does not hold yet.
 * `draft.ts` says so at the top; this file does not assert a property the code
 * does not have.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { INITIAL_DRAFT, TARGET_OPTIONS } from '../../src/web/demo/scenarios.ts';
import {
  blockersFor,
  type Draft,
  draftReducer,
  STEPS,
} from '../../src/web/views/apps/new/draft.ts';
import { NewApp } from '../../src/web/views/apps/new/index.tsx';

const CANDIDATES = TARGET_OPTIONS.filter((target) => target.candidate).map(
  (target) => target.targetId,
);

/** A draft with every prerequisite met — the baseline the others deviate from. */
const clean: Draft = {
  ...INITIAL_DRAFT,
  config: INITIAL_DRAFT.config.map((key) => ({ ...key, supplied: true })),
};

const render = (draft: Draft) =>
  renderToStaticMarkup(
    <NewApp initialDraft={draft} targets={TARGET_OPTIONS} />,
  );

describe('the preflight', () => {
  test('a complete draft has nothing standing in its way', () => {
    expect(blockersFor(clean, CANDIDATES)).toEqual([]);
  });

  test('an unprovisioned vessel blocks, and says who provisions it', () => {
    // §14 and Task 46: vessels are pre-provisioned through Terraform, and
    // Spindrift never creates a project. So the remediation is somebody else's
    // merge, and saying that is the difference between waiting and retrying.
    const blockers = blockersFor(
      { ...clean, vessel: { ...clean.vessel, ready: false } },
      CANDIDATES,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.remediation).toContain('Terraform');
  });

  test('a non-candidate Target blocks', () => {
    const excluded = TARGET_OPTIONS.find((target) => !target.candidate)!;
    const blockers = blockersFor(
      { ...clean, targetId: excluded.targetId },
      CANDIDATES,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.title).toContain('not a candidate');
  });

  test('a config key with no value blocks, and names the key', () => {
    // §10 makes values write-only, so a key left empty here cannot be filled in
    // later from this screen. That is why it is a blocker rather than a warning.
    const blockers = blockersFor(INITIAL_DRAFT, CANDIDATES);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.remediation).toContain('DATABASE_URL');
  });

  test('several unmet prerequisites are all reported', () => {
    // Reporting one at a time turns a blocked draft into a guessing game.
    const blockers = blockersFor(
      { ...INITIAL_DRAFT, vessel: { ...clean.vessel, ready: false } },
      CANDIDATES,
    );
    expect(blockers.length).toBeGreaterThan(1);
  });
});

describe('Review shows the preflight rather than only obeying it', () => {
  const atReview = (draft: Draft): Draft => ({
    ...draft,
    step: STEPS.length - 1,
  });

  test('a blocked draft states what is wrong and what clears it', () => {
    const markup = render(atReview(INITIAL_DRAFT));

    expect(markup).toContain('Spindrift stops before Build #1');
    expect(markup).toContain('DATABASE_URL');
    expect(markup).toContain('Nothing has been created');
    // The draft survives — the rule is "stops before any Build exists", not
    // "discards what the developer entered".
    expect(markup).toContain('This draft is kept');
  });

  test('and the button that would start a Build is off', () => {
    expect(render(atReview(INITIAL_DRAFT))).toContain('disabled');
  });

  test('a clean draft offers the Build instead', () => {
    const markup = render(atReview(clean));

    expect(markup).toContain('Ready to create the App and start Build #1');
    expect(markup).toContain('Start first Build');
    expect(markup).toContain('locks its vessel');
    expect(markup).not.toContain('Nothing has been created');
  });
});

describe('Place lists non-candidates rather than hiding them', () => {
  // §3's grammar: listed, disabled, and annotated with why. An empty list is
  // what makes "nowhere fits" unreadable.
  const markup = render({ ...clean, step: 2 });

  test('every connected Target appears, candidate or not', () => {
    for (const target of TARGET_OPTIONS) {
      expect(markup).toContain(target.name);
    }
  });

  test('each exclusion carries its reason and its sentence', () => {
    for (const target of TARGET_OPTIONS.filter((option) => !option.candidate)) {
      for (const reason of target.reasons) expect(markup).toContain(reason);
      for (const detail of target.detail) expect(markup).toContain(detail);
    }
  });

  test('the vessel is marked immutable while it is still a choice', () => {
    expect(markup).toContain('cannot be changed after the App is created');
  });
});

describe('the draft reducer', () => {
  test('a tile that names a kind preselects it', () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'website',
    });
    expect(next.kind).toBe('website');
  });

  test("a tile that names no kind leaves detection's proposal standing", () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'upload',
    });
    expect(next.kind).toBe(INITIAL_DRAFT.detection.kind);
  });

  test('steps cannot run off either end', () => {
    expect(draftReducer(INITIAL_DRAFT, { type: 'step', step: -3 }).step).toBe(
      0,
    );
    expect(draftReducer(INITIAL_DRAFT, { type: 'step', step: 99 }).step).toBe(
      STEPS.length - 1,
    );
  });
});
