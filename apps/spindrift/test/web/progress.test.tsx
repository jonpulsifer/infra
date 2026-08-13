/**
 * The progress strip, and the one claim it exists to make.
 *
 * Rendered to static markup for the same reason `views.test.tsx` is: every rule
 * here is a statement about what appears on screen in a given state, and none
 * of them is about interaction.
 *
 * The claim that matters is the last one — **a failed deploy whose previous
 * release is still serving does not report the App as down**. §9 never mutates
 * exposure on red, so that pairing is the ordinary shape of a failure, and a
 * strip that painted it all red would be the most frightening wrong thing this
 * screen could say.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeployView } from '../../src/commands/views.ts';
import { StageProgress } from '../../src/web/components/progress.tsx';
import { formatDuration } from '../../src/web/components/running-time.tsx';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { DEPLOY_SCENARIOS } from '../fixtures/scenarios.ts';

const strip = (stages: Parameters<typeof StageProgress>[0]['stages']) =>
  renderToStaticMarkup(<StageProgress stages={stages} />);

const screen = (view: DeployView) =>
  renderToStaticMarkup(<DeployDetail view={view} />);

/** The bar's fill, as the inline style states it. */
const width = (markup: string) => /width:\s*([0-9]+)%/.exec(markup)?.[1];

/** The strip's own summary, which is also what a screen reader is handed. */
const summary = (markup: string) =>
  /aria-label="Progress: ([^"]*)"/.exec(markup)?.[1];

describe('the bar reports settled work, never a guess', () => {
  test('a stage in flight counts a half, not a hopeful fraction', () => {
    expect(
      width(
        strip([
          { name: 'a', status: 'done' },
          { name: 'b', status: 'running' },
          { name: 'c', status: 'waiting' },
          { name: 'd', status: 'waiting' },
        ]),
      ),
    ).toBe('38');
  });

  test('nothing behind a failure is credited as progress', () => {
    // The two stages after the failure are `done` on the row, which is what a
    // naive count would add up. A red pipeline stopped where it stopped.
    expect(
      width(
        strip([
          { name: 'a', status: 'done' },
          { name: 'b', status: 'failed' },
          { name: 'c', status: 'done' },
          { name: 'd', status: 'done' },
        ]),
      ),
    ).toBe('25');
  });

  test('everything settled fills it', () => {
    expect(
      width(
        strip([
          { name: 'a', status: 'done' },
          { name: 'b', status: 'done' },
        ]),
      ),
    ).toBe('100');
  });

  test('only the moving bar moves', () => {
    expect(strip([{ name: 'a', status: 'running' }])).toContain(
      'animate-pulse',
    );
    expect(strip([{ name: 'a', status: 'done' }])).not.toContain(
      'animate-pulse',
    );
  });
});

describe('the strip a release renders', () => {
  test('a live release is green all the way to serving', () => {
    expect(summary(screen(DEPLOY_SCENARIOS.live as DeployView))).toBe(
      'Source done, Build done, Deploy done, Live done',
    );
  });

  test('a build in flight has not started the deploy', () => {
    expect(summary(screen(DEPLOY_SCENARIOS.building as DeployView))).toBe(
      'Source done, Build running, Deploy running, Live queued',
    );
  });

  test('a failed build leaves the App up, and says so', () => {
    // Failed at Build, and `Live` is *queued* rather than failed: the previous
    // release is still serving, so the App is not down.
    const markup = screen(DEPLOY_SCENARIOS.buildFailed as DeployView);
    expect(summary(markup)).toBe(
      'Source done, Build failed, Deploy failed, Live queued',
    );
    expect(markup).toContain('previous release');
  });
});

describe('a running duration', () => {
  test('reads as minutes and seconds, then hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9_400)).toBe('0:09');
    expect(formatDuration(64_000)).toBe('1:04');
    expect(formatDuration(3_729_000)).toBe('1:02:09');
  });

  test('never counts backwards through clock skew', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
  });
});
