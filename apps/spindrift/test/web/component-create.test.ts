/**
 * What the Components card posts when it adds a Component, and what the press
 * that first deploys the new row names (ticket 118, §2).
 *
 * `createComponentInput` is a `.strict()` discriminated union
 * (`src/commands/components/create.ts:68-98`), so the fields a kind does not
 * take are not fields the command ignores — they are a validation failure. That
 * makes the composition a claim worth pinning, and it is asserted against the
 * schema itself: a shape this file thought was right and the command refused
 * would be a test agreeing with the bug.
 *
 * Against `componentCreation` rather than the mounted screen, for the reason
 * `test/web/workspace-refresh.test.ts` states: reaching it there means pressing
 * a kind tile, and `test/harness/dom.ts` simulates no clicks.
 */
import { describe, expect, test } from 'bun:test';
import { createComponentInput } from '../../src/commands/components/create.ts';
import { componentCreation, targetForFirstDeploy } from '../../src/web/app.tsx';
import type { WorkspaceView } from '../../src/web/model.ts';
import { WORKSPACE_SCENARIOS } from '../fixtures/scenarios.ts';

const APP_ID = '3f0f2f2a-6d2a-4a1a-9f3e-2a5b1c0d4e6f';

/** The command's own schema, as the dispatcher applies it. */
const accepted = (input: unknown) => createComponentInput.safeParse(input);

describe('what the Components card posts', () => {
  test('a service carries expose and no schedule', () => {
    const input = componentCreation(APP_ID, { name: 'web', kind: 'service' });

    expect(input).toEqual({
      appId: APP_ID,
      name: 'web',
      kind: 'service',
      expose: true,
      reach: 'private',
      auth: 'proxy',
    });
    expect(accepted(input).success).toBe(true);
  });

  test('a website carries neither', () => {
    const input = componentCreation(APP_ID, { name: 'docs', kind: 'website' });

    expect(input).not.toHaveProperty('expose');
    expect(input).not.toHaveProperty('schedule');
    expect(accepted(input).success).toBe(true);
  });

  test('a job carries its schedule, and omits it when there is none', () => {
    const scheduled = componentCreation(APP_ID, {
      name: 'nightly',
      kind: 'job',
      schedule: '0 3 * * *',
    });
    expect(scheduled).toEqual({
      appId: APP_ID,
      name: 'nightly',
      kind: 'job',
      schedule: '0 3 * * *',
      reach: 'private',
      auth: 'proxy',
    });
    expect(accepted(scheduled).success).toBe(true);

    // Absent rather than empty: §7 renders an unscheduled job as a suspended
    // CronJob, and `''` is not a five-field cron expression — the schema says
    // so, which is why the form must not send one.
    const unscheduled = componentCreation(APP_ID, {
      name: 'nightly',
      kind: 'job',
    });
    expect(unscheduled).not.toHaveProperty('schedule');
    expect(accepted(unscheduled).success).toBe(true);
    expect(accepted({ ...unscheduled, schedule: '' }).success).toBe(false);
  });

  test('the strictness this composition exists for', () => {
    // The failure a single flat payload would produce: a schedule on a service
    // is refused outright, so "send everything and let the command sort it out"
    // is not a shape this command has.
    const service = componentCreation(APP_ID, { name: 'web', kind: 'service' });
    expect(accepted({ ...service, schedule: '0 3 * * *' }).success).toBe(false);
  });
});

describe('the Target a first Deploy names', () => {
  const placed: WorkspaceView = WORKSPACE_SCENARIOS.service;

  /** The App as it reads with a Component added beside the placed one. */
  const withAnUnplacedSelection = (): WorkspaceView => ({
    ...placed,
    // The selection is the new row, so the workspace carries no placement of
    // record — which is exactly the state `getAppWorkspace` answers with for a
    // Component `createComponent` has just written.
    componentId: 'component-nightly',
    targetId: undefined,
    components: [
      { ...placed.components[0]!, target: 'bluenose/kubernetes' },
      {
        id: 'component-nightly',
        name: 'nightly',
        kind: 'job',
        phase: 'PENDING',
        artifact: 'no artifact yet',
        reach: 'private',
        auth: 'proxy',
      },
    ],
  });

  test('is the sibling’s, where the selected Component has no placement', () => {
    // Without this the first press on a Component the card just added is
    // refused: `deployApp` will not guess a Target, and a first deploy is what
    // writes one.
    expect(targetForFirstDeploy(withAnUnplacedSelection())).toBe(
      'bluenose/kubernetes',
    );
  });

  test('is nothing at all where the selection is placed', () => {
    // A Target named against an existing placement is a move, and moves go
    // through `placeComponent` — so the press must not carry one.
    expect(
      targetForFirstDeploy({ ...placed, targetId: 'target-metal' }),
    ).toBeUndefined();
  });

  test('is nothing where no Component of this App is placed either', () => {
    const nowhere = withAnUnplacedSelection();
    expect(
      targetForFirstDeploy({
        ...nowhere,
        components: nowhere.components.map(
          ({ target: _target, ...row }) => row,
        ),
      }),
    ).toBeUndefined();
  });
});
