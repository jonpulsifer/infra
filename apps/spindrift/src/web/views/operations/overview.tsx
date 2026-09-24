/**
 * The landing screen: a verdict, what is serving, counts, Apps and Targets, and
 * the newest Builds and Deploys. A count from a paged read carries a `+` and is
 * scoped to the page, because this screen has no fleet total.
 */
import { Radio } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  TargetListItem,
} from '../../../commands/views.ts';
import {
  DefinitionGrid,
  type ExplorerItem,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { Ref } from '../../ui/copy.tsx';
import { type Column, DataTable } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Metric, type MetricTone } from '../../ui/metric.tsx';
import { Page } from '../../ui/page.tsx';
import { Skeleton, SkeletonRows } from '../../ui/skeleton.tsx';
import { Tabs } from '../../ui/tabs.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { appHref } from '../apps/list.tsx';
import { ScreenFailure } from '../screen.tsx';
import { buildTone } from '../supply-chain/builds.tsx';
import { deployTone, deployWord } from './deploys.tsx';

/** One Build or one Deploy in the feed, with what its inspector needs. */
interface Entry extends ExplorerItem {
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

type Lane = 'all' | 'attention' | 'inflight' | 'builds' | 'deploys';

/**
 * Vessel and adapter, since neither identifies a Target alone. An unplaced App
 * has no Vessel yet and shows the adapter by itself.
 */
function targetName(vessel: string, adapter: string): string {
  return vessel ? `${vessel}/${adapter}` : adapter;
}

function appTone(phase: AppListItem['phase']): MetricTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'warning';
}

/** A `+` marks a count that is only the newest page. */
function pageCount(loaded: number, hasMore: boolean): string {
  return hasMore ? `${loaded}+` : String(loaded);
}

/**
 * The headline over the counts. Branch order is priority: a failed App outranks
 * a Target needing attention, which outranks work in flight.
 */
export function verdict(counts: {
  apps: number;
  failedApps: number;
  inFlightApps: number;
  failedDeploys: number;
  failedBuilds: number;
  runningBuilds: number;
  attentionTargets: number;
  liveApps: number;
}): { headline: string; lede: string } {
  if (counts.apps === 0) {
    return {
      headline: 'Nothing is running yet.',
      lede: 'Create an App and Spindrift will build it, place it on a Target, and put an address in front of it.',
    };
  }
  if (counts.failedApps > 0) {
    return {
      headline:
        counts.failedApps === 1
          ? 'One App needs you.'
          : `${counts.failedApps} Apps need you.`,
      lede: `${counts.liveApps} of ${counts.apps} are serving. A Component's newest release did not come up — the one before it is still what answers.`,
    };
  }
  if (counts.attentionTargets > 0) {
    return {
      headline: 'Everything is serving.',
      lede: `All ${counts.apps} Apps are up, but ${counts.attentionTargets} ${counts.attentionTargets === 1 ? 'Target needs' : 'Targets need'} attention — a placement that cannot be made is a Deploy that will fail when it is.`,
    };
  }
  const moving = counts.inFlightApps + counts.runningBuilds;
  if (moving > 0) {
    return {
      headline: 'All serving. Something shipping.',
      lede: `${counts.liveApps} of ${counts.apps} Apps are up, and ${moving} ${moving === 1 ? 'thing is' : 'things are'} moving right now.`,
    };
  }
  if (counts.failedDeploys > 0 || counts.failedBuilds > 0) {
    return {
      headline: 'Everything is serving.',
      lede: `All ${counts.apps} Apps are up. There are failures further back in the ledger — nothing that is failing is what answers a request.`,
    };
  }
  return {
    headline: 'Everything is serving.',
    lede: `All ${counts.apps} Apps are up, nothing is in flight, and every Target is healthy.`,
  };
}

export function Overview({
  apps,
  builds,
  deploys,
  targets,
  buildsHasMore = false,
  deploysHasMore = false,
  onNavigate,
}: {
  readonly apps: readonly AppListItem[];
  readonly builds: readonly BuildListItem[];
  readonly deploys: readonly DeployLedgerItem[];
  readonly targets: readonly TargetListItem[];
  /** Whether the Build and Deploy reads left a next page: it adds the `+`. */
  readonly buildsHasMore?: boolean;
  readonly deploysHasMore?: boolean;
  readonly onNavigate: (path: string) => void;
}) {
  const [lane, setLane] = useState<Lane>('all');

  const liveApps = apps.filter((app) => app.phase === 'LIVE').length;
  const failedApps = apps.filter((app) => app.phase === 'FAILED').length;
  const inFlightApps = apps.length - liveApps - failedApps;

  const inFlightDeploys = deploys.filter(
    (deploy) => deploy.phase !== 'LIVE' && deploy.phase !== 'FAILED',
  ).length;
  const failedDeploys = deploys.filter(
    (deploy) => deploy.phase === 'FAILED',
  ).length;

  const runningBuilds = builds.filter(
    (build) => build.status === 'RUNNING' || build.status === 'PENDING',
  ).length;
  const failedBuilds = builds.filter(
    (build) => build.status === 'FAILED',
  ).length;
  const waitingBuilds = builds.filter(
    (build) => build.dispatchWaitingOn !== null,
  ).length;

  const healthyTargets = targets.filter(
    (target) =>
      target.configured &&
      target.status === 'connected' &&
      target.health === 'healthy',
  ).length;
  const attentionTargets = targets.length - healthyTargets;

  const serving = deploys.filter((deploy) => deploy.current);
  const appById = useMemo(
    () => new Map(apps.map((app) => [app.id, app])),
    [apps],
  );

  const entries = useMemo((): readonly Entry[] => {
    const fromDeploys = deploys.map(
      (deploy): Entry => ({
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
    const fromBuilds = builds.map((build): Entry => {
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
  }, [builds, deploys]);

  const attentionCount = entries.filter(
    (entry) => entry.tone === 'destructive' || entry.tone === 'warning',
  ).length;
  const inFlightCount = entries.filter((entry) => entry.active).length;

  const feed = entries.filter((entry) => {
    if (lane === 'attention') {
      return entry.tone === 'destructive' || entry.tone === 'warning';
    }
    if (lane === 'inflight') return entry.active;
    if (lane === 'builds') return entry.kind === 'build';
    if (lane === 'deploys') return entry.kind === 'deploy';
    return true;
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const { headline, lede } = verdict({
    apps: apps.length,
    failedApps,
    inFlightApps,
    failedDeploys,
    failedBuilds,
    runningBuilds,
    attentionTargets,
    liveApps,
  });

  return (
    <Page>
      <section
        aria-label="The state of this installation"
        className="relative overflow-hidden rounded-lg border border-border bg-card px-6 py-8 sm:px-9 sm:py-11"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_150%_at_96%_-30%,var(--accent-soft),transparent_58%)] opacity-70"
        />
        <div className="relative flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <p className="font-mono text-micro font-bold uppercase tracking-eyebrow text-muted-foreground">
              {apps.length} Apps · {targets.length} Targets
            </p>
            <h1 className="max-w-[18ch] text-balance text-verdict font-semibold tracking-display">
              {headline}
            </h1>
            <p className="max-w-[62ch] text-ui leading-relaxed text-subtle">
              {lede}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onNavigate('/apps/new')}>Create App</Button>
            <Button variant="outline" onClick={() => onNavigate('/deploys')}>
              Deploy ledger
            </Button>
            <Button
              variant="outline"
              onClick={() => onNavigate('/settings/connections')}
            >
              Connect Target
            </Button>
          </div>
        </div>
      </section>

      <Serving
        serving={serving}
        appById={appById}
        onNavigate={onNavigate}
        hasApps={apps.length > 0}
      />

      <section
        aria-label="Counts"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Metric
          label="Apps"
          value={apps.length}
          tone={failedApps > 0 ? 'destructive' : 'idle'}
          onClick={() => onNavigate('/apps')}
          footnote={`${liveApps} live · ${inFlightApps} in flight · ${failedApps} failed`}
        />
        <Metric
          label="Deploys"
          value={pageCount(deploys.length, deploysHasMore)}
          tone={failedDeploys > 0 ? 'destructive' : 'idle'}
          onClick={() => setLane('deploys')}
          footnote={
            <>
              {inFlightDeploys} in flight · {failedDeploys} failed
              {deploysHasMore
                ? ` — the newest ${deploys.length} loaded, not a fleet total`
                : ''}
            </>
          }
        />
        <Metric
          label="Builds"
          value={pageCount(builds.length, buildsHasMore)}
          tone={
            failedBuilds > 0
              ? 'destructive'
              : waitingBuilds > 0
                ? 'warning'
                : 'idle'
          }
          onClick={() => setLane('builds')}
          footnote={
            <>
              {runningBuilds} running · {waitingBuilds} waiting · {failedBuilds}{' '}
              failed
              {buildsHasMore
                ? ` — the newest ${builds.length} loaded, not a fleet total`
                : ''}
            </>
          }
        />
        <Metric
          label="Targets"
          value={targets.length}
          tone={attentionTargets > 0 ? 'warning' : 'success'}
          onClick={() => onNavigate('/settings/connections')}
          footnote={`${healthyTargets} healthy · ${attentionTargets} need attention`}
        />
      </section>

      <StandingState apps={apps} targets={targets} onNavigate={onNavigate} />

      <section aria-label="Activity" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-title font-semibold tracking-tight">Activity</h2>
          <p className="text-caption text-muted-foreground">
            Builds and Deploys, newest first.
          </p>
        </div>
        <Tabs
          variant="pill"
          label="Filter activity"
          current={lane}
          onSelect={(id) => setLane(id as Lane)}
          items={[
            { id: 'all', label: 'All', count: entries.length },
            { id: 'attention', label: 'Attention', count: attentionCount },
            { id: 'inflight', label: 'In flight', count: inFlightCount },
            { id: 'builds', label: 'Builds', count: builds.length },
            { id: 'deploys', label: 'Deploys', count: deploys.length },
          ]}
        />
        <ObjectExplorer
          items={feed}
          filterPlaceholder="Filter activity…"
          empty={
            <EmptyState
              tone="success"
              title="Nothing has happened yet."
              action={
                <Button onClick={() => onNavigate('/apps/new')}>
                  Create App
                </Button>
              }
            >
              A Build or a Deploy is what writes the first line here.
            </EmptyState>
          }
          renderInspector={(item) => {
            const entry = byId.get(item.id);
            if (!entry) return null;
            const buildPath = entry.buildPath;
            return (
              <>
                <Eyebrow>{entry.eyebrow}</Eyebrow>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <h3 className="text-title font-semibold tracking-tight">
                    {entry.title}
                  </h3>
                  <Badge tone={entry.tone}>{entry.status}</Badge>
                  <Timestamp
                    at={entry.at}
                    when={entry.when}
                    className="text-caption font-mono text-muted-foreground"
                  />
                </div>
                <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
                  {entry.summary}
                </p>
                <DefinitionGrid entries={entry.facts} />
                <div className="mt-6 flex flex-wrap gap-2">
                  <Button onClick={() => onNavigate(entry.path)}>
                    Open {entry.kind === 'build' ? 'Build' : 'Deploy'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(entry.appPath)}
                  >
                    Open App
                  </Button>
                  {buildPath ? (
                    <Button
                      variant="outline"
                      onClick={() => onNavigate(buildPath)}
                    >
                      View Build
                    </Button>
                  ) : null}
                </div>
              </>
            );
          }}
        />
      </section>
    </Page>
  );
}

/**
 * One row per desired release. The address links only when `urlLive`: after a
 * failure the previous release stays exposed, so `url` may serve another one.
 */
function Serving({
  serving,
  appById,
  hasApps,
  onNavigate,
}: {
  readonly serving: readonly DeployLedgerItem[];
  readonly appById: ReadonlyMap<string, AppListItem>;
  readonly hasApps: boolean;
  readonly onNavigate: (path: string) => void;
}) {
  const columns: readonly Column<DeployLedgerItem>[] = [
    {
      id: 'app',
      header: 'App / component',
      sortable: true,
      sortValue: (deploy) => `${deploy.app}/${deploy.component}`,
      cell: (deploy) => (
        <span className="truncate font-semibold">
          {deploy.app} <span className="text-muted-foreground">/</span>{' '}
          {deploy.component}
        </span>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      sortable: true,
      sortValue: (deploy) => deploy.target,
      cell: (deploy) => deploy.target,
    },
    {
      id: 'url',
      header: 'Address',
      cell: (deploy) => {
        const app = appById.get(deploy.appId);
        const href = app?.urlLive ? appHref(app.url) : null;
        if (href) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate font-mono text-body text-primary underline-offset-2 hover:underline"
            >
              {app?.url}
            </a>
          );
        }
        return (
          <span className="truncate text-muted-foreground">
            {app?.url ? 'not serving this release' : 'no address allocated yet'}
          </span>
        );
      },
    },
    {
      id: 'release',
      header: 'Release',
      cell: (deploy) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-muted-foreground">
            #{deploy.buildId}
          </span>
          <Ref
            value={deploy.commit}
            kind="commit"
            headline={deploy.commitMessage}
          />
        </span>
      ),
    },
    {
      id: 'phase',
      header: 'Phase',
      sortable: true,
      sortValue: (deploy) => deploy.phase,
      cell: (deploy) => (
        <Badge tone={deployTone(deploy.phase, deploy.faulty)}>
          {deployWord(deploy.phase, deploy.faulty)}
        </Badge>
      ),
    },
    {
      id: 'since',
      header: 'Since',
      align: 'end',
      sortable: true,
      sortValue: (deploy) => deploy.at,
      cell: (deploy) => (
        <Timestamp
          at={deploy.at}
          when={deploy.when}
          className="font-mono text-muted-foreground"
        />
      ),
    },
  ];

  return (
    <section aria-label="Serving" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-title font-semibold tracking-tight">Serving</h2>
        <p className="text-caption text-muted-foreground">
          The release each Component is meant to be running.
        </p>
      </div>
      <DataTable
        columns={columns}
        rows={serving}
        rowKey={(deploy) => `serving:${deploy.id}`}
        caption="Current releases"
        onRowSelect={(deploy) => onNavigate(`/deploys/${deploy.id}`)}
        empty={
          <EmptyState
            icon={<Radio />}
            title="Nothing is serving yet."
            action={
              <Button onClick={() => onNavigate('/apps/new')}>
                Create App
              </Button>
            }
          >
            {hasApps
              ? 'Every App here is still waiting on its first release to reach a Target.'
              : 'An App with a Component deployed to a Target is what fills this.'}
          </EmptyState>
        }
      />
    </section>
  );
}

function StandingState({
  apps,
  targets,
  onNavigate,
}: {
  readonly apps: readonly AppListItem[];
  readonly targets: readonly TargetListItem[];
  readonly onNavigate: (path: string) => void;
}) {
  const appColumns: readonly Column<AppListItem>[] = [
    {
      id: 'name',
      header: 'App',
      sortable: true,
      sortValue: (app) => app.name,
      cell: (app) => <span className="truncate font-semibold">{app.name}</span>,
    },
    {
      id: 'target',
      header: 'Placed on',
      sortable: true,
      sortValue: (app) => targetName(app.vessel, app.target),
      cell: (app) => (
        <span className="truncate">{targetName(app.vessel, app.target)}</span>
      ),
    },
    {
      id: 'phase',
      header: 'Phase',
      align: 'end',
      sortable: true,
      sortValue: (app) => app.phase,
      cell: (app) => (
        <Badge tone={appTone(app.phase)}>{app.phase.toLowerCase()}</Badge>
      ),
    },
  ];

  const targetColumns: readonly Column<TargetListItem>[] = [
    {
      id: 'name',
      header: 'Target',
      sortable: true,
      sortValue: (target) => targetName(target.vessel, target.adapter),
      cell: (target) => (
        <span className="truncate font-semibold">
          {targetName(target.vessel, target.adapter)}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'Connection',
      sortable: true,
      sortValue: (target) => (target.configured ? target.status : 'setup'),
      cell: (target) =>
        target.configured ? (
          target.status
        ) : (
          <span className="text-warning">never connected</span>
        ),
    },
    {
      id: 'health',
      header: 'Health',
      align: 'end',
      sortable: true,
      sortValue: (target) => target.health,
      cell: (target) =>
        target.health === 'healthy' && target.configured ? (
          <Badge tone="success">healthy</Badge>
        ) : (
          <Badge tone="warning" className="max-w-[18rem] truncate">
            {target.prerequisiteFailures?.[0] ?? 'needs attention'}
          </Badge>
        ),
    },
  ];

  return (
    <section aria-label="Standing state" className="grid gap-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-title font-semibold tracking-tight">Apps</h2>
          <button
            type="button"
            onClick={() => onNavigate('/apps')}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            All Apps
          </button>
        </div>
        <DataTable
          columns={appColumns}
          rows={apps}
          rowKey={(app) => `app:${app.id}`}
          caption="Apps and the Target each is placed on"
          onRowSelect={(app) => onNavigate(`/apps/${app.id}`)}
          empty={
            <EmptyState title="No App exists yet.">
              Creating one is the first act of this product.
            </EmptyState>
          }
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-title font-semibold tracking-tight">Targets</h2>
          <button
            type="button"
            onClick={() => onNavigate('/settings/connections')}
            className="text-caption text-muted-foreground hover:text-foreground"
          >
            Connections
          </button>
        </div>
        <DataTable
          columns={targetColumns}
          rows={targets}
          rowKey={(target) => `target:${target.id}`}
          caption="Targets and their standing checklist"
          onRowSelect={() => onNavigate('/settings/connections')}
          empty={
            <EmptyState title="No Target is declared.">
              A Target is the boundary and surface an App is placed on.
            </EmptyState>
          }
        />
      </div>
    </section>
  );
}

/** Holds the tile strip's height, so the feed does not jump when it loads. */
function OverviewSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <SkeletonRows rows={8} />
    </Page>
  );
}

/**
 * One read for all four, so the counts are the same age. Nothing here pages;
 * `nextBefore` only says whether a count covers the whole ledger.
 */
export function OverviewScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const read = useRead(
    [
      ['listApps', {}],
      ['listBuilds', { limit: 12 }],
      ['listAllDeploys', { limit: 12 }],
      ['listTargets', {}],
    ],
    15_000,
  );

  if (read.type === 'loading') return <OverviewSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Overview"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [apps, builds, deploys, targets] = read.value;
  return (
    <Overview
      apps={apps.apps}
      builds={builds.builds}
      deploys={deploys.deploys}
      targets={targets.targets}
      buildsHasMore={builds.nextBefore !== null}
      deploysHasMore={deploys.nextBefore !== null}
      onNavigate={onNavigate}
    />
  );
}
