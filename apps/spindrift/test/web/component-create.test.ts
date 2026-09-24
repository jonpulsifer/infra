// `createComponentInput` is a strict discriminated union: a field a kind does
// not take is refused, not ignored, so each payload is checked against it.
import { describe, expect, test } from 'bun:test';
import { createComponentInput } from '../../src/commands/components/create.ts';
import type { WorkspaceView } from '../../src/commands/views.ts';
import {
  argvOf,
  componentCreation,
  targetForFirstDeploy,
} from '../../src/web/views/apps/workspace.tsx';
import { WORKSPACE_SCENARIOS } from '../fixtures/scenarios.ts';

const APP_ID = '3f0f2f2a-6d2a-4a1a-9f3e-2a5b1c0d4e6f';

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

    // Omitted, not empty: `''` is not a cron expression.
    const unscheduled = componentCreation(APP_ID, {
      name: 'nightly',
      kind: 'job',
    });
    expect(unscheduled).not.toHaveProperty('schedule');
    expect(accepted(unscheduled).success).toBe(true);
    expect(accepted({ ...unscheduled, schedule: '' }).success).toBe(false);
  });

  test('an entrypoint travels on every kind, and is absent when nothing was typed', () => {
    const worker = componentCreation(APP_ID, {
      name: 'worker',
      kind: 'service',
      command: argvOf('node job.js'),
    });
    expect(worker).toMatchObject({ command: ['node', 'job.js'] });
    expect(accepted(worker).success).toBe(true);

    // Omitted, not empty: `argv` refuses `[]`.
    const plain = componentCreation(APP_ID, {
      name: 'worker',
      kind: 'service',
    });
    expect(plain).not.toHaveProperty('command');
    expect(accepted({ ...plain, command: [] }).success).toBe(false);
    expect(accepted({ ...plain, command: [''] }).success).toBe(false);
  });

  test('a typed entrypoint is split on whitespace', () => {
    expect(argvOf('  node   job.js ')).toEqual(['node', 'job.js']);
    // ponytail: no shell quoting, so this is four words. Pinned because it is
    // the ceiling, not an accident.
    expect(argvOf('sh -c "a b"')).toEqual(['sh', '-c', '"a', 'b"']);
  });

  test('the strictness this composition exists for', () => {
    const service = componentCreation(APP_ID, { name: 'web', kind: 'service' });
    expect(accepted({ ...service, schedule: '0 3 * * *' }).success).toBe(false);
  });
});

describe('the Target a first Deploy names', () => {
  const placed: WorkspaceView = WORKSPACE_SCENARIOS.service;

  const withAnUnplacedSelection = (): WorkspaceView => ({
    ...placed,
    // No placement of record, as `getAppWorkspace` answers for a Component
    // `createComponent` just wrote.
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
    // `deployApp` will not guess a Target, and a first deploy is what writes one.
    expect(targetForFirstDeploy(withAnUnplacedSelection())).toBe(
      'bluenose/kubernetes',
    );
  });

  test('is nothing at all where the selection is placed', () => {
    // A Target against an existing placement is a move, which is `placeComponent`'s act.
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
