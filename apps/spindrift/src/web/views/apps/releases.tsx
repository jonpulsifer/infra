/**
 * Every release of one App, with a rollback on each row the server marks
 * rollbackable. It fetches its own rows, since most visits never open the tab.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DeployLedgerItem } from '../../../commands/views.ts';
import { command } from '../../client.ts';
import { PhasePill } from '../../components/status.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Ref } from '../../ui/copy.tsx';
import { type Column, DataTable } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { notify } from '../../ui/toast.tsx';

type Page =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'loaded';
      readonly deploys: readonly DeployLedgerItem[];
      readonly nextBefore: number | null;
    };

export function Releases({
  app,
  onNavigate,
}: {
  /** The App's id, since two Apps can share a name. */
  readonly app: string;
  readonly onNavigate?: (path: string) => void;
}) {
  const [page, setPage] = useState<Page>({ kind: 'loading' });
  const [olderPending, setOlderPending] = useState(false);

  const load = useCallback(
    (before?: number) => {
      command('listDeploys', {
        app,
        ...(before === undefined ? {} : { before }),
      })
        .then((result) => {
          if (!result.ok) {
            setOlderPending(false);
            setPage({ kind: 'error', message: result.failure.message });
            return;
          }
          setOlderPending(false);
          setPage((current) => ({
            kind: 'loaded',
            deploys:
              before === undefined || current.kind !== 'loaded'
                ? result.value.deploys
                : [...current.deploys, ...result.value.deploys],
            nextBefore: result.value.nextBefore,
          }));
        })
        .catch((cause: unknown) => {
          setOlderPending(false);
          setPage({
            kind: 'error',
            message: cause instanceof Error ? cause.message : 'Server failure',
          });
        });
    },
    [app],
  );

  useEffect(() => {
    setPage({ kind: 'loading' });
    load();
  }, [load]);

  if (page.kind === 'loading') return <SkeletonRows rows={5} />;

  if (page.kind === 'error') {
    return (
      <ErrorState
        title="The releases of this App could not be read"
        message={page.message}
        onRetry={() => {
          setPage({ kind: 'loading' });
          load();
        }}
      />
    );
  }

  if (page.deploys.length === 0) {
    return (
      <EmptyState title="This App has never been released.">
        A Deploy is written the first time somebody places a Build. Until then
        there is no history to roll back to.
      </EmptyState>
    );
  }

  const columns: readonly Column<DeployLedgerItem>[] = [
    {
      id: 'release',
      header: 'Release',
      width: '9rem',
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono">#{row.id}</span>
          {/* A superseded Deploy can still be LIVE, so phase cannot say this. */}
          {row.current ? <Badge tone="success">current</Badge> : null}
        </span>
      ),
    },
    {
      id: 'component',
      header: 'Component',
      cell: (row) => row.component,
      sortable: true,
      sortValue: (row) => row.component,
    },
    {
      id: 'target',
      header: 'Target',
      cell: (row) => row.target,
      sortable: true,
      sortValue: (row) => row.target,
    },
    {
      id: 'commit',
      header: 'Commit',
      cell: (row) => (
        <Ref value={row.commit} kind="commit" headline={row.commitMessage} />
      ),
    },
    {
      id: 'config',
      header: 'Config',
      cell: (row) =>
        row.configVersion ? (
          <Ref value={row.configVersion} kind="digest" />
        ) : (
          <span className="text-muted-foreground">none</span>
        ),
    },
    {
      id: 'phase',
      header: 'State',
      cell: (row) => <PhasePill phase={row.phase} faulty={row.faulty} />,
    },
    {
      id: 'by',
      header: 'By',
      // Absent on a Deploy written before its requester was recorded.
      cell: (row) =>
        row.requestedBy ?? <span className="text-muted-foreground">—</span>,
      sortable: true,
      sortValue: (row) => row.requestedBy ?? '',
    },
    {
      id: 'when',
      header: 'Age',
      align: 'end',
      cell: (row) => (
        <Timestamp
          at={row.at}
          when={row.when}
          className="font-mono text-muted-foreground"
        />
      ),
      sortable: true,
      sortValue: (row) => row.at,
    },
    {
      id: 'act',
      header: '',
      align: 'end',
      cell: (row) => (
        <div className="flex items-center justify-end gap-2">
          <RollbackButton
            deploy={row}
            onDone={() => {
              setPage({ kind: 'loading' });
              load();
            }}
            {...(onNavigate ? { onNavigate } : {})}
          />
          {onNavigate ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onNavigate(`/deploys/${row.id}`)}
            >
              Open
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        columns={columns}
        rows={page.deploys}
        rowKey={(row) => String(row.id)}
        caption={`Releases of ${page.deploys[0]?.app ?? 'this App'}, newest first`}
      />
      {page.nextBefore === null ? (
        <p className="text-center text-caption text-muted-foreground">
          Every release of this App is loaded.
        </p>
      ) : (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={olderPending}
            onClick={() => {
              setOlderPending(true);
              load(page.nextBefore ?? undefined);
            }}
          >
            {olderPending ? 'Loading older releases…' : 'Load older releases'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Reports by toast, since the reload after a rollback replaces the table. */
function RollbackButton({
  deploy,
  onDone,
  onNavigate,
}: {
  readonly deploy: DeployLedgerItem;
  readonly onDone: () => void;
  readonly onNavigate?: (path: string) => void;
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
          detail: `${deploy.component} on ${deploy.target}`,
          ...(onNavigate
            ? {
                action: {
                  label: 'Open Deploy',
                  onSelect: () =>
                    onNavigate(`/deploys/${result.value.deployId}`),
                },
              }
            : {}),
        });
        onDone();
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
    <Button variant="outline" size="sm" disabled={busy} onClick={rollback}>
      {busy ? 'Rolling back…' : 'Roll back'}
    </Button>
  );
}
