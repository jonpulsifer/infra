// The merge of a polled workspace read with the log lines a socket appended.
// Called directly, because `test/harness/dom.ts` simulates no clicks.
import { describe, expect, test } from 'bun:test';
import type { WorkspaceView } from '../../src/commands/views.ts';
import { refreshedWorkspace } from '../../src/web/views/apps/workspace.tsx';
import { WORKSPACE_SCENARIOS } from '../fixtures/scenarios.ts';

const SERVICE: WorkspaceView = WORKSPACE_SCENARIOS.service;

/** A fresh read of the workspace, before the socket appends any lines. */
function firstPage(view: WorkspaceView): WorkspaceView {
  if (view.runtime.kind !== 'stream') throw new Error('not a stream runtime');
  return { ...view, runtime: { ...view.runtime, lines: [] } };
}

describe('refreshing the App workspace', () => {
  test('keeps the lines the socket accumulated for the same Component', () => {
    const merged = refreshedWorkspace(SERVICE, firstPage(SERVICE));

    if (merged.runtime.kind !== 'stream') throw new Error('lost the stream');
    if (SERVICE.runtime.kind !== 'stream') throw new Error('bad fixture');
    expect(merged.runtime.lines).toEqual(SERVICE.runtime.lines);
  });

  test('drops them when the refresh is about a different Component', () => {
    // The selection moved while the read was in flight. The socket refills the
    // lines on its next page.
    const other = firstPage({
      ...SERVICE,
      componentId: 'component-beacon-worker',
      runtime: {
        kind: 'stream',
        componentId: 'component-beacon-worker',
        targetId: '00000000-0000-4000-8000-000000000042',
        lines: [],
        reach: '7 days',
      },
    });

    const merged = refreshedWorkspace(SERVICE, other);

    if (merged.runtime.kind !== 'stream') throw new Error('lost the stream');
    expect(merged.runtime.lines).toEqual([]);
    expect(merged.runtime.componentId).toBe('component-beacon-worker');
  });

  test('drops them when the same Component moved to another Target', () => {
    const moved = firstPage({
      ...SERVICE,
      runtime: {
        kind: 'stream',
        componentId: '00000000-0000-4000-8000-000000000041',
        targetId: '00000000-0000-4000-8000-000000000099',
        lines: [],
        reach: '7 days',
      },
    });

    const merged = refreshedWorkspace(SERVICE, moved);

    if (merged.runtime.kind !== 'stream') throw new Error('lost the stream');
    expect(merged.runtime.lines).toEqual([]);
  });

  test('takes a runtime of another kind whole', () => {
    const job = WORKSPACE_SCENARIOS.jobBehindService;

    expect(refreshedWorkspace(SERVICE, job)).toEqual(job);
  });

  test('keeps the socket’s "nothing is running" over the read that cannot tell', () => {
    // `getAppWorkspace` answers `stream` for any placed Component without
    // asking the adapter, so only the socket can report `none`.
    const silent: WorkspaceView = {
      ...SERVICE,
      runtime: { kind: 'none', because: 'No replicas are running.' },
    };

    const merged = refreshedWorkspace(silent, firstPage(SERVICE));

    expect(merged.runtime).toEqual({
      kind: 'none',
      because: 'No replicas are running.',
    });
  });

  test('lets the read win once the release has moved', () => {
    // A Deploy changes what is running, so it makes the socket's `none` stale.
    const silent: WorkspaceView = {
      ...SERVICE,
      runtime: { kind: 'none', because: 'No replicas are running.' },
    };
    const redeployed = firstPage({
      ...SERVICE,
      latestDeployId: (SERVICE.latestDeployId ?? 0) + 1,
    });

    const merged = refreshedWorkspace(silent, redeployed);

    expect(merged.runtime.kind).toBe('stream');
  });
});
