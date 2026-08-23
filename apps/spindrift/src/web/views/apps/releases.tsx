/**
 * Every release of one App, and the one act available on an old one (§2, §6).
 *
 * §2 makes "one Build → many Deploys" the sentence that "makes
 * rollback-without-rebuild possible", and `listDeploys` has answered it per App
 * since the command registry was written — including a `rollbackable` flag
 * computed under the same comparison `rollbackDeploy` makes. Nothing in the
 * browser had ever called it. The workspace instead offered `Browse Builds` and
 * `Browse Deploys`, which jump to the *global* unfiltered ledgers, so going back
 * one release meant guessing your way into a `/deploys/:id` and hoping it
 * belonged to this App. This tab is that command reaching a screen.
 *
 * **It fetches its own rows.** Every other card in the workspace is handed its
 * data by the screen that owns the App, and this one is not, because the
 * releases are a second page of history that most visits never open — loading
 * twenty-five Deploy rows on every workspace read, and again on every two-second
 * poll while something is in flight, to serve a tab nobody pressed is the wrong
 * trade. The read is scoped to the App and re-run after a rollback, and nothing
 * else invalidates it.
 *
 * **A rollback is offered only where `rollbackable`.** Absent rather than
 * disabled, for the reason the ledger states: a disabled control says "later",
 * and a Build that is not older than what is desired is not waiting to become
 * older. The command can still refuse for something this list cannot see — a
 * disconnected Target, a signature that stopped verifying — and that refusal is
 * a sentence the operator reads rather than something to pre-empt by hiding
 * the button.
 *
 * What it refuses: a diff between two releases, filtering, and any notion of
 * "promote". A release is a row that was written once; comparing two of them is
 * the attempt screen's job, and it is one press away from every row here.
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
  /** The App's id — `listDeploys` takes a name too, but two Apps can wear one. */
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
            // Appended rather than replaced when this is an older page: the
            // reader asked for more history, not for different history.
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
          {/* The one marker that says which of these is the answer to "what is
              running". §6: which release *should* be running is the desired
              row's, and a LIVE Deploy a newer intent superseded is still LIVE —
              so `phase` alone cannot say it. */}
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
      // §10's pinned hash is what makes a rollback reproducible, and it is the
      // only thing on the row that says two releases of one Build differ.
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
      cell: (row) => <PhasePill phase={row.phase} />,
    },
    {
      id: 'by',
      header: 'By',
      // "Did I press that or did a push do it?" — the one question a list of
      // releases could not answer. A dash is a release older than the record.
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

/**
 * Make an older release live again, from the row that names it.
 *
 * The outcome goes to the toast host rather than into this row: a rollback
 * navigates nowhere and replaces the table under the reader, so a sentence
 * rendered in a cell would be destroyed by the reload that proves it worked.
 */
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
