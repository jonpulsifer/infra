/**
 * The landing screen, as an answer rather than a database browser.
 *
 * It was titled "Object explorer" and it earned the name: four object kinds —
 * Deploys, Builds, Targets, Apps — concatenated into one list in *array* order,
 * which is not time order and could never become time order, because two of the
 * four carry no instant at all. An operator opening the product was handed a
 * heterogeneous scroll and left to find the question themselves.
 *
 * So it is four named zones now, in the order the questions are asked.
 *
 * **Serving** is first and is the one this product exists to answer: what is in
 * front of users right now. `current` is the only field that knows — §6 keeps a
 * superseded release `LIVE`, so "which of these LIVE rows is the one serving" is
 * unanswerable from `phase` — and it was rendered nowhere on this screen. The
 * address is a real link only when `urlLive`, because a link to an address
 * serving someone else's release is worse than no link.
 *
 * **Counts** come second, and they say what they are. The tiles used to read
 * `deploys.length` off an array the caller had fetched with `limit: 12` and
 * present it as a fleet total, so a hundred-Deploy installation reported twelve.
 * When the caller says there is another page, the value carries a `+` and the
 * footnote scopes it to the newest N. A tile that cannot know the total must not
 * print one.
 *
 * **Standing state** is third: Apps and Targets, which have a condition rather
 * than a moment. Hoisting them out of the feed is what makes the feed sortable —
 * they were the rows with no `at`.
 *
 * **Activity** is last, sorted by `at` descending across Builds and Deploys, and
 * the tiles filter it: a count of three failures that leaves the reader to find
 * which three is a count doing half its job.
 *
 * What this screen refuses: a fleet activity command, a chart, and any total it
 * would have to invent. `listBuilds`/`listAllDeploys` return a page and a
 * cursor; a real fleet summary is a server read this screen does not have, and
 * inventing one from a page is exactly the bug being fixed.
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
import { Page, PageHeader } from '../../ui/page.tsx';
import { Skeleton, SkeletonRows } from '../../ui/skeleton.tsx';
import { Tabs } from '../../ui/tabs.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { appHref } from '../apps/list.tsx';
import { ScreenFailure } from '../screen.tsx';
import { buildTone } from '../supply-chain/builds.tsx';
import { deployTone } from './deploys.tsx';

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
 * A Target's name is both halves of it.
 *
 * `views.ts` is explicit that neither the boundary nor the surface identifies a
 * Target alone, and two clusters both running `kubernetes` were the same word
 * twice on this screen. An unplaced App has no boundary yet, and says the
 * surface alone rather than inventing a `/`.
 */
function targetName(vessel: string, adapter: string): string {
  return vessel ? `${vessel}/${adapter}` : adapter;
}

function appTone(phase: AppListItem['phase']): MetricTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'warning';
}

/** A count that is only the newest page says so, in the value and beside it. */
function pageCount(loaded: number, hasMore: boolean): string {
  return hasMore ? `${loaded}+` : String(loaded);
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
  /**
   * Whether the caller's Build/Deploy reads left a next page behind. Optional
   * and false by default: a caller that has not been taught to keep its cursor
   * gets the old, smaller claim — the loaded rows — rather than a `+` it cannot
   * back up.
   */
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
    // Newest first across both kinds. This is the sort the old concatenation
    // could not do: Targets and Apps have no instant, so a list holding them
    // had no comparable key and stayed in the order the four reads returned.
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

  return (
    <Page>
      <PageHeader
        eyebrow="Control plane"
        title="Operations"
        description="What is serving, what it cost to get there, and what is still moving."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => onNavigate('/settings/connections')}
            >
              Connect Target
            </Button>
            <Button variant="outline" onClick={() => onNavigate('/deploys')}>
              Deploy ledger
            </Button>
            <Button onClick={() => onNavigate('/apps/new')}>Create App</Button>
          </>
        }
      />

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
 * What is in front of users, and where.
 *
 * One row per desired release. The address is an anchor only where the read
 * model says that address currently serves *this* release: §6 leaves the
 * previous release exposed after a failure, so a link rendered from `url` alone
 * would send an operator to a page that disagrees with the row they clicked it
 * from.
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
          <Ref value={deploy.commit} kind="commit" />
        </span>
      ),
    },
    {
      id: 'phase',
      header: 'Phase',
      sortable: true,
      sortValue: (deploy) => deploy.phase,
      cell: (deploy) => (
        <Badge tone={deployTone(deploy.phase)}>
          {deploy.phase.toLowerCase()}
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

/**
 * The two kinds with a condition rather than a moment.
 *
 * They were rows in the feed, which is why the feed could not be sorted. Side
 * by side they answer the two standing questions instead: what exists, and what
 * it can be placed on.
 */
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
      // The first unmet prerequisite is the whole reason a Target is amber, and
      // it was reachable only by selecting the row on a list of four kinds.
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

/**
 * The landing screen, loading.
 *
 * Its own shape rather than the shared `LedgerSkeleton` with more rows, because
 * the tile strip is the tallest thing above the fold: standing in for it with
 * rows moves the feed up by a hundred pixels and then drops it back down, which
 * is the jump a skeleton exists to prevent.
 */
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
 * The landing screen — four reads, one answer.
 *
 * Four commands in one read rather than four screens' worth of independent
 * ones: the tiles are a single claim about the installation, and letting each
 * land on its own would draw a fleet that is four different ages across one
 * row of numbers.
 *
 * Both paged reads ask for twelve and answer with the cursor for the
 * thirteenth, which this screen used to drop on the floor — and then counted
 * the twelve it kept as if they were the fleet. Keeping the cursor is the whole
 * fix: nothing here pages, it only needs to know that "3 running" is three of
 * the newest twelve and not three in the installation.
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
