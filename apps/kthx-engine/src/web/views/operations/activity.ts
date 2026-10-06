/**
 * The Builds and Deploys feed, newest first, as the Overview and the Apps
 * screen's aside both show it. Sites add no entries: kthx keeps no event log.
 */
import type {
  BuildListItem,
  DeployLedgerItem,
} from '../../../commands/views.ts';
import type { ExplorerItem } from '../../components/object-explorer.tsx';
import { buildTone } from '../supply-chain/builds.tsx';
import { deployTone, deployWord } from './deploys.tsx';

/** One Build or one Deploy in the feed, with what its inspector needs. */
export interface ActivityEntry extends ExplorerItem {
  readonly kind: 'build' | 'deploy';
  readonly at: string;
  readonly eyebrow: string;
  readonly summary: string;
  readonly path: string;
  readonly appPath: string;
  readonly buildPath?: string;
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly mono?: boolean;
  }[];
}

export function activityEntries(
  builds: readonly BuildListItem[],
  deploys: readonly DeployLedgerItem[],
): readonly ActivityEntry[] {
  const fromDeploys = deploys.map(
    (deploy): ActivityEntry => ({
      id: `deploy:${deploy.id}`,
      kind: 'deploy',
      title: `Deploy ${deploy.id}`,
      detail: `${deploy.app} / ${deploy.component} · ${deploy.target}`,
      status: deployWord(deploy.phase, deploy.faulty),
      tone: deployTone(deploy.phase, deploy.faulty),
      when: deploy.when,
      at: deploy.at,
      active: deploy.phase !== 'LIVE' && deploy.phase !== 'FAILED',
      eyebrow: `Deploy / ${deploy.id}`,
      summary: `Build ${deploy.buildId} is placed on ${deploy.target}.`,
      path: `/deploys/${deploy.id}`,
      appPath: `/apps/${deploy.appId}`,
      buildPath: `/builds/${deploy.buildId}`,
      search: `${deploy.commit} ${deploy.app} ${deploy.target}`,
      facts: [
        { label: 'Build', value: `#${deploy.buildId}`, mono: true },
        { label: 'Target', value: deploy.target },
        { label: 'Commit', value: deploy.commit.slice(0, 12), mono: true },
        { label: 'Serving', value: deploy.current ? 'yes' : 'superseded' },
      ],
    }),
  );
  const fromBuilds = builds.map((build): ActivityEntry => {
    const waitingOn = build.dispatchWaitingOn;
    return {
      id: `build:${build.id}`,
      kind: 'build',
      title: `Build ${build.id}`,
      detail:
        waitingOn !== null
          ? `${build.app} / ${build.component} · waiting: ${waitingOn}`
          : `${build.app} / ${build.component} · ${build.runner ?? 'queued'}`,
      status: waitingOn !== null ? 'waiting' : build.status.toLowerCase(),
      tone: buildTone(build),
      when: build.when,
      at: build.at,
      active: build.status === 'RUNNING' || build.status === 'PENDING',
      eyebrow: `Build / ${build.id}`,
      summary:
        waitingOn ??
        `Commit ${build.commit.slice(0, 12)} is becoming a ${build.artifactType} artifact.`,
      path: `/builds/${build.id}`,
      appPath: `/apps/${build.appId}`,
      search: `${build.commit} ${build.app} ${waitingOn ?? ''}`,
      facts: [
        { label: 'Runner', value: build.runner ?? 'not dispatched' },
        { label: 'Shape', value: build.targetShape, mono: true },
        {
          label: 'Artifact',
          value: build.artifactDigest ?? 'not produced',
          mono: true,
        },
        ...(waitingOn !== null
          ? [{ label: 'Waiting on', value: waitingOn }]
          : []),
      ],
    };
  });
  return [...fromDeploys, ...fromBuilds].sort((left, right) =>
    right.at.localeCompare(left.at),
  );
}
