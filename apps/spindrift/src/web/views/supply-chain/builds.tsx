/**
 * Builds — the act between the two nouns, as a table of comparable attempts.
 *
 * The row used to carry three of the eight facts `BuildListItem` ships:
 * `#id · app`, `component · commit`, a status word and a time. `runner`,
 * `targetShape` and `artifactType` were stuffed into the Explorer's invisible
 * `search` string, so an operator could *filter* by runner and never *see* one
 * — and `artifactDigest`, the thing the whole act exists to produce, reached
 * only the inspector.
 *
 * `dispatchWaitingOn` is the one that mattered. `views.ts` calls it "what a
 * PENDING Build is stuck on, in the operator's own words", the Overview
 * rendered it, and the screen named after Builds did not — so a Build
 * permanently refused because no configured route meets its Target's threshold
 * looked exactly like one that started two seconds ago. It is a column here,
 * in the artifact slot, because a Build that is waiting has no artifact and the
 * reason it has none is the honest thing to put where one would go.
 *
 * The evidence panel is still a per-selection fetch and still does not follow a
 * running attempt: `getBuildDetail` is called once per selected Build, so the
 * step list beside a RUNNING row stays at whatever it was when the row was
 * clicked while the status badge updates from the list poll. That is a real gap
 * and it wants the attempt stream, not an interval.
 */
import { useEffect, useState } from 'react';
import type { BuildListItem } from '../../../commands/views.ts';
import { command, type OutputOf } from '../../client.ts';
import { Checklist } from '../../components/checklist.tsx';
import {
  DefinitionGrid,
  type ExplorerTone,
  LedgerExplorer,
} from '../../components/object-explorer.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { Ref } from '../../ui/copy.tsx';
import type { Column } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { LedgerSkeleton, mergeLedger, ScreenFailure } from '../screen.tsx';
import { SupplyChainFlow, SupplyChainTabs } from './tabs.tsx';

/**
 * The tone a Build's state deserves, including the state that is not one.
 *
 * A PENDING Build refusing every tick is not "in progress" the way a RUNNING
 * one is — it needs an operator to configure the thing it is waiting on, which
 * is what `warning` already means everywhere else. Shared with the Overview so
 * the same Build is never two colours on two screens.
 */
export function buildTone(
  build: Pick<BuildListItem, 'status' | 'dispatchWaitingOn'>,
): ExplorerTone {
  if (build.status === 'FAILED') return 'destructive';
  if (build.status === 'SUCCEEDED') return 'success';
  if (build.dispatchWaitingOn !== null) return 'warning';
  return 'accent';
}

const COLUMNS: readonly Column<BuildListItem>[] = [
  {
    id: 'id',
    header: '#',
    mono: true,
    width: '5.5rem',
    sortable: true,
    sortValue: (build) => build.id,
    cell: (build) => `#${build.id}`,
  },
  {
    id: 'app',
    header: 'App / component',
    sortable: true,
    sortValue: (build) => `${build.app}/${build.component}`,
    cell: (build) => (
      <span className="truncate">
        {build.app} <span className="text-muted-foreground">/</span>{' '}
        {build.component}
      </span>
    ),
  },
  {
    id: 'commit',
    header: 'Commit',
    sortable: true,
    sortValue: (build) => build.commit,
    cell: (build) => (
      <Ref value={build.commit} kind="commit" headline={build.commitMessage} />
    ),
  },
  {
    id: 'runner',
    header: 'Runner',
    sortable: true,
    sortValue: (build) => build.runner ?? '',
    cell: (build) =>
      build.runner ?? (
        <span className="text-muted-foreground">supplied artifact</span>
      ),
  },
  {
    id: 'shape',
    header: 'Shape',
    mono: true,
    cell: (build) => build.targetShape,
  },
  {
    id: 'artifact',
    header: 'Artifact',
    cell: (build) =>
      build.dispatchWaitingOn !== null ? (
        <span className="text-warning">{build.dispatchWaitingOn}</span>
      ) : build.artifactDigest ? (
        <Ref value={build.artifactDigest} kind="digest" />
      ) : (
        <span className="text-muted-foreground">not produced</span>
      ),
  },
  {
    id: 'status',
    header: 'State',
    sortable: true,
    sortValue: (build) => build.status,
    cell: (build) => (
      <Badge tone={buildTone(build)}>
        {build.dispatchWaitingOn !== null
          ? 'waiting'
          : build.status.toLowerCase()}
      </Badge>
    ),
  },
  {
    id: 'age',
    header: 'Created',
    align: 'end',
    sortable: true,
    sortValue: (build) => build.at,
    cell: (build) => (
      <Timestamp
        at={build.at}
        when={build.when}
        className="font-mono text-muted-foreground"
      />
    ),
  },
];

export function BuildLedger({
  builds,
  onNavigate,
  hasMore = false,
  loadingMore = false,
  loadError = null,
  onLoadMore,
}: {
  readonly builds: readonly BuildListItem[];
  readonly onNavigate: (path: string) => void;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly loadError?: string | null;
  readonly onLoadMore?: () => void;
}) {
  return (
    <Page>
      <SupplyChainTabs current="builds" onNavigate={onNavigate} />
      <PageHeader
        eyebrow="Build ledger"
        title="Builds"
        description="The act between the two nouns: a Source becomes an Artifact here. Placement remains a separate Deploy, with its own state and evidence."
      />
      <LedgerExplorer
        columns={COLUMNS}
        rows={builds}
        rowKey={(build) => `build:${build.id}`}
        rowSearch={(build) =>
          `${build.id} ${build.app} ${build.component} ${build.commit} ${build.status} ${build.runner ?? ''} ${build.targetShape} ${build.artifactType} ${build.artifactDigest ?? ''} ${build.dispatchWaitingOn ?? ''}`
        }
        filterPlaceholder={`Filter ${builds.length} Builds…`}
        caption="Builds, newest first"
        inspectorLabel={(build) => `Build ${build.id}`}
        empty={
          <EmptyState title="No Builds exist yet.">
            Creating and deploying an App starts the first one.
          </EmptyState>
        }
        renderInspector={(build) => (
          <>
            <Eyebrow>Build / {build.id}</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-title font-semibold tracking-tight">
                {build.app} / {build.component}
              </h2>
              <Badge tone={buildTone(build)}>
                {build.status.toLowerCase()}
              </Badge>
            </div>
            {build.dispatchWaitingOn !== null ? (
              <p className="mt-3 rounded-sm border border-warning/50 px-3 py-2 text-body text-warning">
                Waiting: {build.dispatchWaitingOn}
              </p>
            ) : null}
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
              Turning commit <span className="font-mono">{build.commit}</span>{' '}
              into a {build.artifactType} artifact for {build.targetShape}.
            </p>
            <DefinitionGrid
              entries={[
                { label: 'State', value: build.status.toLowerCase() },
                {
                  label: 'Created',
                  value: <Timestamp at={build.at} when={build.when} />,
                  title: build.at,
                  mono: true,
                },
                {
                  label: 'Runner',
                  value: build.runner ?? 'supplied artifact',
                },
                {
                  label: 'Artifact',
                  value: build.artifactDigest ? (
                    <Ref value={build.artifactDigest} kind="digest" />
                  ) : (
                    'not produced'
                  ),
                  title: build.artifactDigest ?? undefined,
                  mono: true,
                },
                { label: 'Shape', value: build.targetShape, mono: true },
                {
                  label: 'Commit',
                  value: <Ref value={build.commit} kind="commit" />,
                  title: build.commit,
                  mono: true,
                },
                ...(build.commitMessage
                  ? [{ label: 'Message', value: build.commitMessage }]
                  : []),
                ...(build.commitAuthor
                  ? [
                      {
                        label: 'Author',
                        value: build.commitAuthoredAt ? (
                          <>
                            {build.commitAuthor},{' '}
                            <Timestamp at={build.commitAuthoredAt} />
                          </>
                        ) : (
                          build.commitAuthor
                        ),
                        title: build.commitAuthoredAt ?? undefined,
                      },
                    ]
                  : []),
              ]}
            />
            <BuildEvidence buildId={build.id} />
            <div className="mt-6 flex flex-wrap gap-2">
              <Button onClick={() => onNavigate(`/builds/${build.id}`)}>
                Open Build
              </Button>
              {build.deployId !== null ? (
                <Button
                  variant="outline"
                  onClick={() => onNavigate(`/deploys/${build.deployId}`)}
                >
                  Related Deploy
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => onNavigate(`/apps/${build.appId}`)}
              >
                Open App
              </Button>
            </div>
          </>
        )}
      />
      {loadError ? (
        <p className="text-body text-destructive">{loadError}</p>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading older Builds…' : 'Load older Builds'}
          </Button>
        </div>
      ) : builds.length > 0 ? (
        <p className="text-center text-caption text-muted-foreground">
          Entire Build ledger loaded.
        </p>
      ) : null}
      <SupplyChainFlow />
    </Page>
  );
}

/** Real step evidence for the selected Build, loaded only for its inspector. */
function BuildEvidence({ buildId }: { readonly buildId: number }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; detail: OutputOf<'getBuildDetail'> }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ type: 'loading' });
    command('getBuildDetail', { id: buildId })
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', detail: result.value }
            : { type: 'error', message: result.failure.message },
        );
      })
      .catch((cause: unknown) => {
        if (live) {
          setState({
            type: 'error',
            message: cause instanceof Error ? cause.message : 'Evidence failed',
          });
        }
      });
    return () => {
      live = false;
    };
  }, [buildId]);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <Eyebrow>Observed steps</Eyebrow>
      {state.type === 'loading' ? (
        <div className="mt-2">
          <p className="sr-only">Loading Build evidence…</p>
          <SkeletonRows rows={3} />
        </div>
      ) : state.type === 'error' ? (
        <p className="mt-2 text-body text-destructive">{state.message}</p>
      ) : state.detail.attempt.build === null ? (
        <p className="mt-2 text-body text-muted-foreground">
          This was a supplied artifact; no builder ran.
        </p>
      ) : (
        <div className="mt-2">
          <Checklist items={state.detail.attempt.build.steps} />
        </div>
      )}
    </section>
  );
}

/**
 * The Builds screen — the ledger, the cadence it re-reads on, and the page the
 * reader can add below it.
 *
 * The two are why this screen merges rather than replaces: the tick asks for
 * the newest page and is authoritative about those rows, and everything the
 * reader paged in below it is older than anything the tick can answer with. So
 * the fresh page wins per id and `nextBefore` stays where paging left it —
 * taking the tick's cursor would put the reader back at the top of a list they
 * had scrolled through.
 */
export function BuildsScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const read = useRead(
    [['listBuilds', {}]],
    15_000,
    [],
    ([fresh], [current]) => [
      {
        ...fresh,
        builds: mergeLedger(fresh.builds, current.builds),
        nextBefore: current.nextBefore,
      },
    ],
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  const loadOlder = async () => {
    if (read.type !== 'success') return;
    const [listed] = read.value;
    if (listed.nextBefore === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const result = await command('listBuilds', { before: listed.nextBefore });
      if (!result.ok) {
        setOlderError(result.failure.message);
        return;
      }
      read.update(([current]) => [
        {
          ...current,
          builds: mergeLedger(current.builds, result.value.builds),
          nextBefore: result.value.nextBefore,
        },
      ]);
    } catch (cause) {
      setOlderError(
        cause instanceof Error ? cause.message : 'Loading older Builds failed',
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (read.type === 'loading') return <LedgerSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Builds"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [listed] = read.value;
  return (
    <BuildLedger
      builds={listed.builds}
      onNavigate={onNavigate}
      hasMore={listed.nextBefore !== null}
      loadingMore={loadingOlder}
      loadError={olderError}
      onLoadMore={() => void loadOlder()}
    />
  );
}
