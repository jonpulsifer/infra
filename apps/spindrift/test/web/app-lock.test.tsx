/**
 * The lock banner and the pushed-but-not-live line on the workspace hero (§6,
 * §15). Both are columns the command layer now reports, and a column nobody
 * can see is not done.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceView } from '../../src/commands/views.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { Workspace } from '../../src/web/views/apps/workspace.tsx';
import {
  DEPLOY_SCENARIOS,
  WORKSPACE_SCENARIOS,
} from '../fixtures/scenarios.ts';

const LOCKED = {
  ...WORKSPACE_SCENARIOS.service,
  lock: {
    reason:
      'rollback to Build 30 requested, superseding Build 31, by Operator; unlock once the cause is fixed',
    by: 'Operator',
    since: '2h ago',
    at: '2026-08-23T07:00:00.000Z',
  },
} as const satisfies WorkspaceView;

describe('the lock banner', () => {
  test('prints the reason, who, and when, and offers to unlock where it can', () => {
    const markup = renderToStaticMarkup(
      <Workspace view={LOCKED} onSetLock={async () => ({ ok: true })} />,
    );
    expect(markup).toContain('LOCKED');
    expect(markup).toContain('rollback to Build 30 requested');
    expect(markup).toContain('by Operator, 2h ago');
    expect(markup).toContain('Unlock');
    // Locked already: the control that sets a lock is not offered twice.
    expect(markup).not.toContain('Lock deploys');
  });

  test('a screen wiring no acts still shows the lock, without the button', () => {
    const markup = renderToStaticMarkup(<Workspace view={LOCKED} />);
    expect(markup).toContain('LOCKED');
    expect(markup).not.toContain('Unlock');
  });

  test('an unlocked App offers to lock where the act is wired', () => {
    const markup = renderToStaticMarkup(
      <Workspace
        view={WORKSPACE_SCENARIOS.service}
        onSetLock={async () => ({ ok: true })}
      />,
    );
    expect(markup).not.toContain('LOCKED');
    expect(markup).toContain('Lock deploys');
  });
});

describe('pushed but not live', () => {
  const behind = (dispatched: boolean, extra: Partial<WorkspaceView> = {}) =>
    renderToStaticMarkup(
      <Workspace
        view={{
          ...WORKSPACE_SCENARIOS.service,
          commit: 'def4567',
          source: {
            branch: 'main',
            pending: { commit: 'abc1234', dispatched },
          },
          ...extra,
        }}
      />,
    );

  test('names both commits and, with a Build of it on its way, that a deploy is coming', () => {
    const markup = behind(true, { autoDeploy: true });
    expect(markup).toContain('abc1234');
    expect(markup).toContain('def4567');
    expect(markup).toContain('a deploy is coming');
  });

  test('a push App with nothing on its way is told which button ships it', () => {
    // The switch is on and no Build of the commit exists — after an unlock
    // that resumed nothing, or a push whose Build failed. The copy reads the
    // evidence, not the switch.
    const markup = behind(false, { autoDeploy: true });
    expect(markup).toContain('press Rebuild to ship it');
    expect(markup).not.toContain('a deploy is coming');
  });

  test('a manual App is told which button ships it', () => {
    expect(behind(false, { autoDeploy: false })).toContain(
      'press Rebuild to ship it',
    );
  });

  test('a locked App is told the lock is what holds it', () => {
    expect(behind(true, { autoDeploy: true, lock: LOCKED.lock })).toContain(
      'held by the lock',
    );
  });

  test('in step, the line is not rendered', () => {
    const markup = renderToStaticMarkup(
      <Workspace
        view={{
          ...WORKSPACE_SCENARIOS.service,
          source: { branch: 'main', pending: null },
        }}
      />,
    );
    expect(markup).not.toContain(' is at ');
  });
});

describe('who asked, on the release', () => {
  test('a Deploy prints its principal', () => {
    const markup = renderToStaticMarkup(
      <DeployDetail
        view={{ ...DEPLOY_SCENARIOS.live, requestedBy: 'auto-deploy on push' }}
      />,
    );
    expect(markup).toContain('Requested by');
    expect(markup).toContain('auto-deploy on push');
  });
});
