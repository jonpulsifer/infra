import { useState } from 'react';
import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  type ExplorerTone,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  TargetListItem,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

interface Concern extends ExplorerItem {
  readonly category: 'deploy' | 'build' | 'target' | 'app';
  readonly eyebrow: string;
  readonly summary: string;
  readonly path: string;
  readonly appPath?: string;
  readonly buildPath?: string;
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly mono?: boolean;
  }[];
}

function buildTone(
  build: Pick<BuildListItem, 'status' | 'dispatchWaitingOn'>,
): ExplorerTone {
  if (build.status === 'FAILED') return 'destructive';
  if (build.status === 'SUCCEEDED') return 'success';
  // A PENDING Build refusing every tick is not "in progress" the way a
  // RUNNING one is — it needs an operator to configure the thing it is
  // waiting on, which is what 'warning' already means everywhere else on
  // this screen.
  if (build.dispatchWaitingOn !== null) return 'warning';
  return 'accent';
}

function deployTone(phase: DeployLedgerItem['phase']): ExplorerTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'accent';
}

function appTone(phase: AppListItem['phase']): ExplorerTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'warning';
}

type CategoryFilter = 'all' | 'attention' | 'inflight' | 'apps' | 'targets';

export function Overview({
  apps,
  builds,
  deploys,
  targets,
  onNavigate,
}: {
  readonly apps: readonly AppListItem[];
  readonly builds: readonly BuildListItem[];
  readonly deploys: readonly DeployLedgerItem[];
  readonly targets: readonly TargetListItem[];
  readonly onNavigate: (path: string) => void;
}) {
  const [category, setCategory] = useState<CategoryFilter>('all');

  const liveApps = apps.filter((a) => a.phase === 'LIVE').length;
  const failedApps = apps.filter((a) => a.phase === 'FAILED').length;
  const inFlightApps = apps.filter(
    (a) => a.phase !== 'LIVE' && a.phase !== 'FAILED',
  ).length;

  const inFlightDeploys = deploys.filter(
    (d) => d.phase !== 'LIVE' && d.phase !== 'FAILED',
  ).length;
  const failedDeploys = deploys.filter((d) => d.phase === 'FAILED').length;

  const runningBuilds = builds.filter(
    (b) => b.status === 'RUNNING' || b.status === 'PENDING',
  ).length;
  const succeededBuilds = builds.filter((b) => b.status === 'SUCCEEDED').length;
  const waitingBuilds = builds.filter(
    (b) => b.dispatchWaitingOn !== null,
  ).length;

  const healthyTargets = targets.filter(
    (t) => t.configured && t.status === 'connected' && t.health === 'healthy',
  ).length;
  const setupTargets = targets.filter(
    (t) =>
      !t.configured || t.status === 'disconnected' || t.health === 'unhealthy',
  ).length;

  const concerns: Concern[] = [
    ...deploys.map(
      (deploy): Concern => ({
        id: `deploy:${deploy.id}`,
        category: 'deploy',
        title: `Deploy ${deploy.id}`,
        detail: `${deploy.app} / ${deploy.component} · ${deploy.target}`,
        status: deploy.phase.toLowerCase(),
        tone: deployTone(deploy.phase),
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
          { label: 'Build', value: String(deploy.buildId), mono: true },
          { label: 'Target', value: deploy.target },
          { label: 'Started', value: deploy.when, mono: true },
        ],
      }),
    ),
    ...builds.map((build): Concern => {
      const waitingOn = build.dispatchWaitingOn;
      return {
        id: `build:${build.id}`,
        category: 'build',
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
          `Commit ${build.commit} is becoming a ${build.artifactType} artifact.`,
        path: `/builds/${build.id}`,
        appPath: `/apps/${build.appId}`,
        search: `${build.commit} ${build.app} ${waitingOn ?? ''}`,
        facts: [
          { label: 'Runner', value: build.runner ?? 'waiting' },
          { label: 'Shape', value: build.targetShape, mono: true },
          { label: 'Created', value: build.when, mono: true },
          ...(waitingOn !== null
            ? [{ label: 'Waiting on', value: waitingOn }]
            : []),
        ],
      };
    }),
    ...targets.map(
      (target): Concern => ({
        id: `target:${target.id}`,
        category: 'target',
        title: target.name,
        detail: `${target.adapter} Target · ${target.status}`,
        status: target.configured ? target.health : 'setup',
        tone:
          target.configured &&
          target.status === 'connected' &&
          target.health === 'healthy'
            ? 'success'
            : 'warning',
        eyebrow: 'Target',
        summary:
          target.prerequisiteFailures?.[0] ??
          (target.configured
            ? `Target ${target.name} connected via ${target.adapter}.`
            : 'This Target still needs its connection completed.'),
        path: '/settings/connections',
        search: `${target.adapter} ${target.prerequisiteFailures?.join(' ') ?? ''}`,
        facts: [
          { label: 'Adapter', value: target.adapter },
          { label: 'Connection', value: target.status },
          { label: 'Rank', value: String(target.rank), mono: true },
        ],
      }),
    ),
    ...apps.map(
      (app): Concern => ({
        id: `app:${app.id}`,
        category: 'app',
        title: app.name,
        detail: `${app.kind} · ${app.target}`,
        status: app.phase.toLowerCase(),
        tone: appTone(app.phase),
        active: app.phase !== 'LIVE' && app.phase !== 'FAILED',
        eyebrow: `App / ${app.kind}`,
        summary: `${app.source} · ${app.url || 'no URL allocated'}`,
        path: `/apps/${app.id}`,
        search: `${app.source} ${app.url}`,
        facts: [
          { label: 'Target', value: app.target },
          { label: 'Artifact', value: app.artifact, mono: true },
          { label: 'URL', value: app.url || 'not allocated', mono: true },
        ],
      }),
    ),
  ];

  const attentionCount = concerns.filter(
    (c) => c.tone === 'destructive' || c.tone === 'warning',
  ).length;
  const inFlightCount = concerns.filter((c) => c.active).length;

  const filteredConcerns = concerns.filter((concern) => {
    if (category === 'attention') {
      return concern.tone === 'destructive' || concern.tone === 'warning';
    }
    if (category === 'inflight') {
      return concern.active;
    }
    if (category === 'apps') {
      return concern.category === 'app';
    }
    if (category === 'targets') {
      return concern.category === 'target';
    }
    return true;
  });

  const byId = new Map(concerns.map((concern) => [concern.id, concern]));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <ExplorerPageHeader
        eyebrow="Operating view"
        title="Object explorer"
        description="Scan active work, infrastructure state, and operational contracts across all targets."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => onNavigate('/settings/connections')}
            >
              Connect Target
            </Button>
            <Button variant="outline" onClick={() => onNavigate('/deploys')}>
              Deploy Ledger
            </Button>
            <Button onClick={() => onNavigate('/apps/new')}>Create App</Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col justify-between p-4">
          <div>
            <Eyebrow>Applications</Eyebrow>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                {apps.length}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-semibold text-success">{liveApps} Live</span>
            {inFlightApps > 0 ? ` · ${inFlightApps} In-Flight` : ''}
            {failedApps > 0 ? ` · ${failedApps} Failed` : ''}
          </p>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div>
            <Eyebrow>Deploys</Eyebrow>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                {deploys.length}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {inFlightDeploys > 0 ? (
              <span className="font-semibold text-warning">
                {inFlightDeploys} In-Flight
              </span>
            ) : (
              '0 In-Flight'
            )}
            {failedDeploys > 0 ? ` · ${failedDeploys} Failed` : ''}
          </p>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div>
            <Eyebrow>Build Pipeline</Eyebrow>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                {builds.length}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {runningBuilds > 0 ? (
              <span className="font-semibold text-accent-foreground">
                {runningBuilds} Running
              </span>
            ) : (
              `${succeededBuilds} Succeeded`
            )}
            {waitingBuilds > 0 ? (
              <>
                {' · '}
                <span className="font-semibold text-warning">
                  {waitingBuilds} Waiting
                </span>
              </>
            ) : null}
          </p>
        </Card>

        <Card className="flex flex-col justify-between p-4">
          <div>
            <Eyebrow>Infrastructure Targets</Eyebrow>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-foreground">
                {targets.length}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-semibold text-success">
              {healthyTargets} Healthy
            </span>
            {setupTargets > 0 ? ` · ${setupTargets} Attention` : ''}
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        {[
          { id: 'all', label: `All (${concerns.length})` },
          { id: 'attention', label: `Attention Required (${attentionCount})` },
          { id: 'inflight', label: `In-Flight (${inFlightCount})` },
          { id: 'apps', label: `Applications (${apps.length})` },
          { id: 'targets', label: `Targets (${targets.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setCategory(tab.id as CategoryFilter)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              category === tab.id
                ? 'bg-accent text-accent-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ObjectExplorer
        items={filteredConcerns}
        filterPlaceholder="Filter active objects…"
        empty={
          <div className="rounded-sm border border-success/40 bg-card p-10 text-center">
            <p className="font-semibold text-success">Everything is steady.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No objects match the selected filter. Create an App or connect a
              Target to expand your system.
            </p>
            <div className="mt-4 flex justify-center gap-3">
              <Button onClick={() => onNavigate('/apps/new')}>
                Create App
              </Button>
              <Button
                variant="outline"
                onClick={() => onNavigate('/settings/connections')}
              >
                Connect Target
              </Button>
            </div>
          </div>
        }
        renderInspector={(item) => {
          const concern = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>{concern.eyebrow}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {concern.title}
                </h2>
                <Badge tone={concern.tone}>{concern.status}</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {concern.summary}
              </p>
              <DefinitionGrid entries={concern.facts} />
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => onNavigate(concern.path)}>
                  Open {concern.eyebrow.split(' / ')[0]}
                </Button>
                {concern.appPath ? (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(concern.appPath!)}
                  >
                    Open App Workspace
                  </Button>
                ) : null}
                {concern.buildPath ? (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(concern.buildPath!)}
                  >
                    View Build
                  </Button>
                ) : null}
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
