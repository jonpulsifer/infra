/**
 * The one sentence the Overview exists to say.
 *
 * It is computed from counts the screen already had, so the thing worth
 * proving is not arithmetic — it is **precedence**. An installation is rarely
 * in one state: something is red *and* something is moving *and* a Target is
 * unhealthy, all at once, and the banner gets one line. Which fact wins is the
 * whole design, and it is the part a later edit can quietly invert without
 * breaking a render.
 *
 * Every case below is a pair of true facts where only one belongs in the
 * headline.
 */
import { describe, expect, test } from 'bun:test';
import { verdict } from '../../src/web/views/operations/overview.tsx';

/** A healthy installation, as the baseline every case perturbs. */
function counts(overrides: Partial<Parameters<typeof verdict>[0]> = {}) {
  return {
    apps: 6,
    liveApps: 6,
    failedApps: 0,
    inFlightApps: 0,
    failedDeploys: 0,
    failedBuilds: 0,
    runningBuilds: 0,
    attentionTargets: 0,
    ...overrides,
  };
}

describe('what the banner says', () => {
  test('a healthy installation says so, and counts nothing at the reader', () => {
    const { headline, lede } = verdict(counts());
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('6 Apps are up');
  });

  test('an empty installation is onboarding, not a zero', () => {
    // Six metric tiles reading 0 is what a fresh install used to arrive at.
    const { headline, lede } = verdict(counts({ apps: 0, liveApps: 0 }));
    expect(headline).toBe('Nothing is running yet.');
    expect(lede).toContain('Create an App');
  });

  test('one failing App is singular, several are plural', () => {
    expect(verdict(counts({ failedApps: 1, liveApps: 5 })).headline).toBe(
      'One App needs you.',
    );
    expect(verdict(counts({ failedApps: 3, liveApps: 3 })).headline).toBe(
      '3 Apps need you.',
    );
  });

  test('the red App says the previous release is still answering', () => {
    // §18's rule for the deploy screen, applied to the front door: the thing
    // that makes a failed release survivable is that something is still up.
    const { lede } = verdict(counts({ failedApps: 1, liveApps: 5 }));
    expect(lede).toContain('the one before it is still what answers');
  });
});

describe('which fact wins when several are true', () => {
  test('a failed App outranks anything in flight', () => {
    // A release that is still trying is not the thing you were paged for.
    const both = verdict(
      counts({ failedApps: 1, liveApps: 4, inFlightApps: 1, runningBuilds: 2 }),
    );
    expect(both.headline).toBe('One App needs you.');
  });

  test('a failed App outranks an unhealthy Target', () => {
    const both = verdict(
      counts({ failedApps: 1, liveApps: 5, attentionTargets: 2 }),
    );
    expect(both.headline).toBe('One App needs you.');
  });

  test('an unhealthy Target is named even while everything serves', () => {
    // The case this branch exists for: nothing is down, and the next Deploy
    // to that Target will be. Silence here is how that gets found at 3am.
    const { headline, lede } = verdict(counts({ attentionTargets: 1 }));
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('1 Target needs attention');
  });

  test('and it is pluralised on its own count, not the App count', () => {
    expect(verdict(counts({ attentionTargets: 2 })).lede).toContain(
      '2 Targets need attention',
    );
  });

  test('work in flight is reported once everything standing is healthy', () => {
    const { headline, lede } = verdict(
      counts({ inFlightApps: 1, liveApps: 5, runningBuilds: 2 }),
    );
    expect(headline).toBe('All serving. Something shipping.');
    // In-flight Apps and running Builds are both "moving", counted together —
    // a reader does not care which layer the movement is in.
    expect(lede).toContain('3 things are moving');
  });

  test('one moving thing is singular', () => {
    expect(verdict(counts({ inFlightApps: 1, liveApps: 5 })).lede).toContain(
      '1 thing is moving',
    );
  });

  test('failures behind the ledger never claim something is down', () => {
    // A FAILED Deploy in the ledger with every App serving is the ordinary
    // aftermath of a rollback. Saying "an App needs you" there is a false page.
    const { headline, lede } = verdict(
      counts({ failedDeploys: 4, failedBuilds: 2 }),
    );
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('nothing that is failing is what answers a request');
  });
});

describe('the sentence is always a sentence', () => {
  test('every branch ends in a full stop and neither half is empty', () => {
    const cases = [
      counts({ apps: 0, liveApps: 0 }),
      counts(),
      counts({ failedApps: 1, liveApps: 5 }),
      counts({ failedApps: 2, liveApps: 4 }),
      counts({ attentionTargets: 1 }),
      counts({ inFlightApps: 1, liveApps: 5 }),
      counts({ runningBuilds: 1 }),
      counts({ failedDeploys: 1 }),
      counts({ failedBuilds: 1 }),
    ];
    for (const input of cases) {
      const { headline, lede } = verdict(input);
      expect(headline.length).toBeGreaterThan(0);
      expect(lede.length).toBeGreaterThan(0);
      expect(headline.endsWith('.')).toBe(true);
      expect(lede.endsWith('.')).toBe(true);
      // A count that reached the copy as `undefined` or `NaN` renders as a
      // word, and every branch here interpolates at least one.
      expect(lede).not.toContain('undefined');
      expect(lede).not.toContain('NaN');
    }
  });
});
