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

const width = (markup: string) => /width:\s*([0-9]+)%/.exec(markup)?.[1];

const summary = (markup: string) =>
  /aria-label="Progress: ([^"]*)"/.exec(markup)?.[1];

describe('the running stage says what history says, never a fraction', () => {
  test('a release in flight carries the history sentence on its Deploy leg', () => {
    const markup = screen({
      ...DEPLOY_SCENARIOS.building,
      expectedDuration: { p90Ms: 250_000, samples: 12 },
    });

    expect(markup).toContain('usually about 4:10, from 12 deploys');
  });

  test('without history the leg names the Target, and a settled release never estimates', () => {
    expect(screen(DEPLOY_SCENARIOS.building)).not.toContain('usually about');
    expect(
      screen({
        ...DEPLOY_SCENARIOS.live,
        expectedDuration: { p90Ms: 250_000, samples: 12 },
      }),
    ).not.toContain('usually about');
  });
});

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
      'animate-shimmer',
    );
    expect(strip([{ name: 'a', status: 'done' }])).not.toContain(
      'animate-shimmer',
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
    // `Live` is queued, not failed: a failed deploy leaves the previous release serving.
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
