/**
 * Deploys — the placement ledger, as a table with the act it was missing.
 *
 * Two facts the server computed and the screen threw away.
 *
 * `current` is the difference between "this release reached LIVE" and "this
 * release is what should be running": `views.ts` says outright that a LIVE
 * Deploy a newer intent has superseded is still LIVE, and only the desired row
 * knows. That was one `yes`/`no` cell in the inspector; it is a column now,
 * because the question "which of these seven LIVE rows is the one serving" is
 * the reason an operator opens this screen.
 *
 * `rollbackable` is computed by `commands/deploys/list.ts` under the *same*
 * comparison `rollbackDeploy` makes, and `views.ts` explains why: so the act is
 * offered only where it would be accepted, rather than offered everywhere and
 * refused half the time. It appeared nowhere in this area. The inspector now
 * carries the act itself — a rollback is an ordinary deploy naming an older
 * Build, so this posts the same intent the App workspace would and reports the
 * refusal verbatim when core declines it.
 *
 * What it refuses: an impact review before the press. `DisconnectTargetControl`
 * has the right precedent for a consequential act and rollback deserves it, but
 * a rollback is reversible by another rollback and a dialog primitive is out of
 * scope this session — so the button states what it will do, the result says
 * what happened, and neither pretends the ceremony exists.
 */
import { useEffect, useState } from 'react';
import type { DeployLedgerItem, DeployPhase } from '../../../commands/views.ts';
import deployFlow from '../../client/diagrams/deploy.svg';
import { command, type OutputOf } from '../../client.ts';
import { Checklist } from '../../components/checklist.tsx';
import { Flow } from '../../components/flow.tsx';
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
import { notify } from '../../ui/toast.tsx';
import { LedgerSkeleton, mergeLedger, ScreenFailure } from '../screen.tsx';

export function deployTone(phase: DeployPhase): ExplorerTone {
  if (phase === 'LIVE') return 'success';
  if (phase === 'FAILED') return 'destructive';
  return 'accent';
}

const COLUMNS: readonly Column<DeployLedgerItem>[] = [
  {
    id: 'id',
    header: '#',
    mono: true,
    width: '5.5rem',
    sortable: true,
    sortValue: (deploy) => deploy.id,
    cell: (deploy) => `#${deploy.id}`,
  },
  {
    id: 'app',
    header: 'App / component',
    sortable: true,
    sortValue: (deploy) => `${deploy.app}/${deploy.component}`,
    cell: (deploy) => (
      <span className="truncate">
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
    id: 'build',
    header: 'Build',
    mono: true,
    sortable: true,
    sortValue: (deploy) => deploy.buildId,
    cell: (deploy) => `#${deploy.buildId}`,
  },
  {
    id: 'commit',
    header: 'Commit',
    cell: (deploy) => <Ref value={deploy.commit} kind="commit" />,
  },
  {
    id: 'current',
    header: 'Serving',
    sortable: true,
    sortValue: (deploy) => (deploy.current ? 0 : 1),
    cell: (deploy) =>
      deploy.current ? (
        <Badge tone="success">current</Badge>
      ) : (
        <span className="text-muted-foreground">superseded</span>
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
    id: 'age',
    header: 'Started',
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

export function DeployLedger({
  deploys,
  onNavigate,
  hasMore = false,
  loadingMore = false,
  loadError = null,
  onLoadMore,
}: {
  readonly deploys: readonly DeployLedgerItem[];
  readonly onNavigate: (path: string) => void;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly loadError?: string | null;
  readonly onLoadMore?: () => void;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Placement ledger"
        title="Deploys"
        description="Verified artifacts are placed and observed here. Build failures stay in Builds; runtime and rollout evidence stays with the Deploy."
      />
      <LedgerExplorer
        columns={COLUMNS}
        rows={deploys}
        rowKey={(deploy) => `deploy:${deploy.id}`}
        rowSearch={(deploy) =>
          `${deploy.id} ${deploy.app} ${deploy.component} ${deploy.target} ${deploy.buildId} ${deploy.commit} ${deploy.phase} ${deploy.configVersion ?? ''}`
        }
        filterPlaceholder={`Filter ${deploys.length} Deploys…`}
        caption="Deploys, newest first"
        inspectorLabel={(deploy) => `Deploy ${deploy.id}`}
        empty={
          <EmptyState title="No Deploys exist yet.">
            A successful Build becomes placeable here.
          </EmptyState>
        }
        renderInspector={(deploy) => (
          <>
            <Eyebrow>Deploy / {deploy.id}</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-title font-semibold tracking-tight">
                {deploy.app} / {deploy.component}
              </h2>
              <Badge tone={deployTone(deploy.phase)}>
                {deploy.phase.toLowerCase()}
              </Badge>
              {deploy.current ? <Badge tone="success">current</Badge> : null}
            </div>
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
              Placing Build {deploy.buildId} on {deploy.target}. This attempt
              pins commit <span className="font-mono">{deploy.commit}</span>.
            </p>
            <DefinitionGrid
              entries={[
                { label: 'State', value: deploy.phase.toLowerCase() },
                { label: 'Build', value: `#${deploy.buildId}`, mono: true },
                { label: 'Target', value: deploy.target },
                {
                  label: 'Started',
                  value: <Timestamp at={deploy.at} when={deploy.when} />,
                  title: deploy.at,
                  mono: true,
                },
                {
                  label: 'Config',
                  value: deploy.configVersion ? (
                    <Ref value={deploy.configVersion} kind="digest" />
                  ) : (
                    'none'
                  ),
                  title: deploy.configVersion ?? undefined,
                  mono: true,
                },
                {
                  label: 'Serving',
                  value: deploy.current
                    ? 'yes — this is desired'
                    : 'superseded',
                },
              ]}
            />
            <DeployEvidence deployId={deploy.id} />
            <div className="mt-6 flex flex-wrap gap-2">
              <Button onClick={() => onNavigate(`/deploys/${deploy.id}`)}>
                Open Deploy
              </Button>
              <Button
                variant="outline"
                onClick={() => onNavigate(`/apps/${deploy.appId}`)}
              >
                Open App
              </Button>
              <RollbackControl deploy={deploy} onNavigate={onNavigate} />
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
            {loadingMore ? 'Loading older Deploys…' : 'Load older Deploys'}
          </Button>
        </div>
      ) : deploys.length > 0 ? (
        <p className="text-center text-caption text-muted-foreground">
          Entire Deploy ledger loaded.
        </p>
      ) : null}
      <Flow
        src={deployFlow}
        label="What happens between pressing Deploy and a workload existing"
        alt="The intent commits under a locking read on the one Component-and-Target row; the reconciler claims it with SKIP LOCKED and lets the lock go, applies through the deploy adapter, and records the phases the platform reported. A failure never touches exposure — the previous release is still serving."
      />
    </Page>
  );
}

/**
 * Go back to this release's Build, where core would accept it.
 *
 * Absent rather than disabled when `rollbackable` is false. A disabled button
 * says "you may do this later"; the truth is that this Build is not older than
 * what is desired, which is not a state waiting to change on this row.
 */
function RollbackControl({
  deploy,
  onNavigate,
}: {
  readonly deploy: DeployLedgerItem;
  readonly onNavigate: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!deploy.rollbackable) return null;

  const rollback = () => {
    setBusy(true);
    command('rollbackDeploy', {
      componentId: deploy.componentId,
      targetId: deploy.targetId,
      buildId: deploy.buildId,
    })
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          notify({
            tone: 'destructive',
            title: 'Rollback refused',
            detail: result.failure.message,
          });
          return;
        }
        notify({
          tone: 'success',
          title: `Rolled back to Build ${deploy.buildId}`,
          detail: `${deploy.app} / ${deploy.component} on ${deploy.target}`,
          action: {
            label: 'Open Deploy',
            onSelect: () => onNavigate(`/deploys/${result.value.deployId}`),
          },
        });
      })
      .catch((cause: unknown) => {
        setBusy(false);
        notify({
          tone: 'destructive',
          title: 'Rollback failed',
          detail: cause instanceof Error ? cause.message : 'Server failure',
        });
      });
  };

  return (
    <Button variant="outline" disabled={busy} onClick={rollback}>
      {busy ? 'Rolling back…' : `Roll back to Build ${deploy.buildId}`}
    </Button>
  );
}

/** Real Build and placement evidence for the selected Deploy inspector. */
function DeployEvidence({ deployId }: { readonly deployId: number }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; detail: OutputOf<'getDeployDetail'> }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ type: 'loading' });
    command('getDeployDetail', { id: deployId })
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
  }, [deployId]);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <Eyebrow>Observed evidence</Eyebrow>
      {state.type === 'loading' ? (
        <div className="mt-2">
          <p className="sr-only">Loading Deploy evidence…</p>
          <SkeletonRows rows={4} />
        </div>
      ) : state.type === 'error' ? (
        <p className="mt-2 text-body text-destructive">{state.message}</p>
      ) : (
        <div className="mt-2 grid gap-5">
          <div>
            <p className="mb-1 text-caption font-semibold text-muted-foreground">
              Placement
            </p>
            <Checklist items={state.detail.deploy.resources} />
          </div>
          <div>
            <p className="mb-1 text-caption font-semibold text-muted-foreground">
              Artifact production
            </p>
            {state.detail.deploy.build === null ? (
              <p className="py-2 text-body text-muted-foreground">
                Supplied artifact; no builder ran.
              </p>
            ) : (
              <Checklist items={state.detail.deploy.build.steps} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The Deploys screen — the ledger and its two sources of rows.
 *
 * Merged on the tick for the reason the Builds screen is: the cadence owns the
 * newest page, the reader owns everything paged in below it, and `nextBefore`
 * belongs to whichever of the two last paged.
 */
export function DeploysScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const read = useRead(
    [['listAllDeploys', {}]],
    15_000,
    [],
    ([fresh], [current]) => [
      {
        ...fresh,
        deploys: mergeLedger(fresh.deploys, current.deploys),
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
      const result = await command('listAllDeploys', {
        before: listed.nextBefore,
      });
      if (!result.ok) {
        setOlderError(result.failure.message);
        return;
      }
      read.update(([current]) => [
        {
          ...current,
          deploys: mergeLedger(current.deploys, result.value.deploys),
          nextBefore: result.value.nextBefore,
        },
      ]);
    } catch (cause) {
      setOlderError(
        cause instanceof Error ? cause.message : 'Loading older Deploys failed',
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (read.type === 'loading') return <LedgerSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Deploys"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [listed] = read.value;
  return (
    <DeployLedger
      deploys={listed.deploys}
      onNavigate={onNavigate}
      hasMore={listed.nextBefore !== null}
      loadingMore={loadingOlder}
      loadError={olderError}
      onLoadMore={() => void loadOlder()}
    />
  );
}
