/**
 * Functions — every `fetch(request, env)` handler this installation deploys,
 * top-level and independent of any App.
 *
 * A row is a link to its own editor (`/functions/<name>`); there is no
 * inspector here, because a function's whole state — source, target, the
 * deploy it last produced — is the one thing worth opening, not a fact this
 * ledger row summarises twice.
 */
import { Plus, Zap } from 'lucide-react';
import type { FunctionListItem } from '../../../commands/views.ts';
import { useRead } from '../../poll.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { type Column, DataTable } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { LedgerSkeleton, ScreenFailure } from '../screen.tsx';

const TARGET_LABEL = {
  'cloudflare-workers': 'Workers',
  'cloud-run-functions': 'Cloud Run',
} as const;

const COLUMNS: readonly Column<FunctionListItem>[] = [
  {
    id: 'name',
    header: 'Name',
    sortable: true,
    sortValue: (fn) => fn.name,
    cell: (fn) => <span className="truncate font-medium">{fn.name}</span>,
  },
  {
    id: 'target',
    header: 'Target',
    sortable: true,
    sortValue: (fn) => fn.target,
    cell: (fn) => <Badge tone="idle">{TARGET_LABEL[fn.target]}</Badge>,
  },
  {
    id: 'url',
    header: 'URL',
    cell: (fn) =>
      fn.url ? (
        <a
          href={fn.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
          className="truncate font-mono text-body text-primary underline-offset-2 hover:underline"
        >
          {fn.url}
        </a>
      ) : (
        <span className="truncate text-muted-foreground">not deployed</span>
      ),
  },
  {
    id: 'deployed',
    header: 'Deployed',
    align: 'end',
    sortable: true,
    sortValue: (fn) => fn.deployedAt ?? '',
    cell: (fn) =>
      fn.deployedAt ? (
        <Timestamp
          at={fn.deployedAt}
          className="font-mono text-muted-foreground"
        />
      ) : (
        <span className="text-muted-foreground">never</span>
      ),
  },
  {
    id: 'status',
    header: '',
    width: '2.5rem',
    cell: (fn) =>
      fn.error ? (
        <span className="text-warning" title={fn.error}>
          <Dot />
        </span>
      ) : null,
  },
];

export function FunctionsScreen({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  const read = useRead([['listFunctions', {}]], 10_000);

  if (read.type === 'loading') return <LedgerSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Functions"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [{ functions }] = read.value;

  return (
    <Page>
      <PageHeader
        eyebrow="Function ledger"
        title="Functions"
        description="A JavaScript export default { fetch(request, env) } handler, deployed straight to Cloudflare Workers or Cloud Run functions — no App, no Build."
        actions={
          <Button onClick={() => onNavigate('/functions/new')}>
            <Plus aria-hidden="true" className="size-4" /> New function
          </Button>
        }
      />
      <DataTable
        columns={COLUMNS}
        rows={functions}
        rowKey={(fn) => fn.id}
        caption="Functions, by name"
        onRowSelect={(fn) => onNavigate(`/functions/${fn.name}`)}
        empty={
          <EmptyState
            icon={<Zap />}
            title="No functions exist yet."
            action={
              <Button onClick={() => onNavigate('/functions/new')}>
                New function
              </Button>
            }
          >
            Write a fetch handler, run it in a sandbox, and deploy it as its own
            public endpoint.
          </EmptyState>
        }
      />
    </Page>
  );
}
