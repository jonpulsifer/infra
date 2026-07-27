/**
 * The deploy contract's closed vocabulary.
 *
 * A failure test asserts the sentence the user reads, not that an error was
 * thrown — the closed reason set and `blame` exist precisely so a failure has an
 * assertable identity (§ Testing). This file asserts that identity: the eight
 * reasons, their blame, and that a stream ends on a verdict carrying one.
 */
import { describe, expect, test } from 'bun:test';
import {
  BLAME,
  type Blame,
  blameFor,
  type DeployAdapter,
  type DeployEvent,
  type DeployVerdict,
  type FailureReason,
  reasonCovers,
} from '../../src/adapters/deploy/contract.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';

/**
 * §6's table, transcribed. A reviewer can check this against the spec without
 * reading it, because the whole table is here:
 *
 * | Reason | Blame | Covers |
 * | --- | --- | --- |
 * | `BUILD_FAILED` | developer | compile error, failed build step |
 * | `ARTIFACT_UNAVAILABLE` | platform | image pull failure, registry auth, missing object |
 * | `REJECTED` | developer | admission webhook, invalid spec, quota, org policy |
 * | `STARTUP_FAILED` | developer | crash loop, exits non-zero, revision will not start |
 * | `UNHEALTHY` | developer | readiness never passed |
 * | `TIMEOUT` | — | no terminal state within budget |
 * | `TARGET_UNREACHABLE` | platform | credentials expired, cluster down, API unreachable |
 * | `INTERNAL` | platform | adapter bug |
 */
const TABLE = [
  ['BUILD_FAILED', 'developer', 'compile error, failed build step'],
  [
    'ARTIFACT_UNAVAILABLE',
    'platform',
    'image pull failure, registry auth, missing object',
  ],
  [
    'REJECTED',
    'developer',
    'admission webhook, invalid spec, quota, org policy',
  ],
  [
    'STARTUP_FAILED',
    'developer',
    'crash loop, exits non-zero, revision will not start',
  ],
  ['UNHEALTHY', 'developer', 'readiness never passed'],
  ['TIMEOUT', null, 'no terminal state within budget'],
  [
    'TARGET_UNREACHABLE',
    'platform',
    'credentials expired, cluster down, API unreachable',
  ],
  ['INTERNAL', 'platform', 'adapter bug'],
] as const satisfies readonly (readonly [
  FailureReason,
  Blame | null,
  string,
])[];

/** A type-level claim that fails to compile if `T` is not exactly `true`. */
type Assert<T extends true> = T;

describe("§6's failure vocabulary", () => {
  test('is the eight reasons the table names, and no others', () => {
    expect(Object.keys(BLAME).sort()).toEqual(
      TABLE.map(([reason]) => reason).sort(),
    );
  });

  test('is closed — no ninth reason is left uncovered', () => {
    const covered: Assert<
      Exclude<FailureReason, (typeof TABLE)[number][0]> extends never
        ? true
        : false
    > = true;
    expect(covered).toBe(true);
  });

  for (const [reason, blame, covers] of TABLE) {
    test(`${reason} blames ${blame ?? 'nobody'}`, () => {
      expect(blameFor(reason)).toBe(blame);
      expect(BLAME[reason]).toBe(blame);
    });

    test(`${reason} covers ${covers}`, () => {
      expect(reasonCovers(reason)).toBe(covers);
    });
  }

  test('a reason outside the union is not a reason', () => {
    // @ts-expect-error — the union is closed; free text lives in `detail`
    const invented: FailureReason = 'ROBOT_UPRISING';
    expect(Object.keys(BLAME)).not.toContain(invented);
  });
});

const target = { name: 'somewhere', adapter: 'kubernetes' } as const;

const desired: DesiredState = {
  app: 'app',
  component: 'web',
  target: target.name,
  kind: 'service',
  artifact: { type: 'image', digest: 'sha256:beef', refs: [] },
  expose: true,
  exposure: 'private',
  config: [],
  requirements: { platform: { os: 'linux', arch: 'arm64' }, resources: {} },
  hostname: { canonical: 'web.example.test' },
};

/**
 * A red adapter, written here rather than reached for from the harness, because
 * what is under test is the contract's own shape: that a stream of events
 * resolves to a verdict, and that the verdict is what carries the reason.
 */
const refuses: DeployAdapter = {
  adapter: 'kubernetes',
  artifactTypes: ['image'],
  async *apply(): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    yield { type: 'status', at: new Date(), phase: 'APPLYING' };
    yield { type: 'log', at: new Date(), line: 'pulling', resource: 'web' };
    return {
      phase: 'FAILED',
      reason: 'ARTIFACT_UNAVAILABLE',
      detail: 'the registry refused the pull',
    };
  },
  async observe() {
    return null;
  },
  async destroy() {},
};

describe('apply', () => {
  test('streams events and ends on a terminal verdict', async () => {
    const stream = refuses.apply(target, desired);
    const events: DeployEvent[] = [];
    let step = await stream.next();
    while (!step.done) {
      events.push(step.value);
      step = await stream.next();
    }
    const verdict = step.value;

    expect(events.map((event) => event.type)).toEqual(['status', 'log']);
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase !== 'FAILED') throw new Error('unreachable');
    expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
    // The green build with the red deploy: the case blame exists for (§6).
    expect(blameFor(verdict.reason)).toBe('platform');
  });
});

describe('destroy', () => {
  test('is idempotent', async () => {
    await refuses.destroy(target, 'anything');
    await refuses.destroy(target, 'anything');
    expect(await refuses.observe(target, 'anything')).toBeNull();
  });
});
