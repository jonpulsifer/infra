/**
 * What a refresh of the App workspace is allowed to keep.
 *
 * The screen holds two sources for one card: the poll re-reads the workspace
 * every few seconds, and a socket appends log lines to whatever the last read
 * returned. Keeping the accumulated lines across a refresh is what stops the
 * log being wiped on every tick — and it is exactly the step that has to notice
 * the selection, because the Component the card is about can change between the
 * read being issued and its answer landing.
 *
 * Asserted against the merge itself rather than the mounted screen: reaching it
 * there means pressing a Component row, and `test/harness/dom.ts` states that
 * it simulates no clicks.
 */
import { describe, expect, test } from 'bun:test';
import type { WorkspaceView } from '../../src/commands/views.ts';
import { refreshedWorkspace } from '../../src/web/app.tsx';
import { WORKSPACE_SCENARIOS } from '../fixtures/scenarios.ts';

const SERVICE: WorkspaceView = WORKSPACE_SCENARIOS.service;

/** The same workspace as the server writes it: one page of lines, or none. */
function firstPage(view: WorkspaceView): WorkspaceView {
  if (view.runtime.kind !== 'stream') throw new Error('not a stream runtime');
  return { ...view, runtime: { ...view.runtime, lines: [] } };
}

describe('refreshing the App workspace', () => {
  test('keeps the lines the socket accumulated for the same Component', () => {
    const merged = refreshedWorkspace(SERVICE, firstPage(SERVICE));

    if (merged.runtime.kind !== 'stream') throw new Error('lost the stream');
    if (SERVICE.runtime.kind !== 'stream') throw new Error('bad fixture');
    // Without this the tail on screen is emptied every tick, which is the whole
    // reason the merge exists.
    expect(merged.runtime.lines).toEqual(SERVICE.runtime.lines);
  });

  test('drops them when the refresh is about a different Component', () => {
    // Two service Components of one App: the selection moved while a read was
    // in flight, so the answer describes the other Component's stream. Its
    // output under this Component's name is the one thing the card must not
    // say, and the socket refills it on the next page.
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
    // A job selected while a service was on screen: there are no lines to keep
    // and the run list is the whole answer.
    const job = WORKSPACE_SCENARIOS.jobBehindService;

    expect(refreshedWorkspace(SERVICE, job)).toEqual(job);
  });

  test('keeps the socket’s "nothing is running" over the read that cannot tell', () => {
    // `getAppWorkspace` answers `stream` for any placed Component without
    // asking the adapter, so this is the disagreement on every tick for a
    // Component that is placed and not running. Letting the read win put the
    // card back to an empty log until the socket said `none` again — a title
    // and a body that swapped every twenty seconds for as long as the screen
    // was open.
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
    // A Deploy is the thing that changes what is running, so it is what makes
    // the socket's last answer stale rather than more current than the read.
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
