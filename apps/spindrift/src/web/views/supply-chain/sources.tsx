/**
 * The Sources ledger: one row per staged digest, which may feed several Builds.
 * Retention is what was promised; fetchable is whether a build route can be
 * handed the location.
 */
import { PackageOpen } from 'lucide-react';
import type { OutputOf } from '../../client.ts';
import {
  DefinitionGrid,
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
import { Timestamp } from '../../ui/timestamp.tsx';
import { LedgerSkeleton, ScreenFailure } from '../screen.tsx';
import { SupplyChainTabs } from './tabs.tsx';

export type SourceListItem = OutputOf<'listSources'>['sources'][number];

/**
 * The algorithm and 12 hex characters, as plain text for headings and
 * accessible names. {@link Ref} shortens the same way but renders a control.
 */
export function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.split(':');
  if (hex === undefined) return digest;
  return `${algorithm}:${hex.slice(0, 12)}`;
}

const COLUMNS: readonly Column<SourceListItem>[] = [
  {
    id: 'digest',
    header: 'Digest',
    sortable: true,
    sortValue: (source) => source.digest,
    cell: (source) => <Ref value={source.digest} kind="digest" />,
  },
  {
    id: 'app',
    header: 'App / component',
    sortable: true,
    sortValue: (source) => `${source.app}/${source.component}`,
    cell: (source) => (
      <span className="truncate">
        {source.app} <span className="text-muted-foreground">/</span>{' '}
        {source.component}
      </span>
    ),
  },
  {
    id: 'origin',
    header: 'Origin',
    sortable: true,
    sortValue: (source) => `${source.origin} ${source.repository ?? ''}`,
    cell: (source) =>
      source.origin === 'repo' ? (
        <span className="truncate">{source.repository ?? 'repository'}</span>
      ) : (
        <span className="text-muted-foreground">upload</span>
      ),
  },
  {
    id: 'commit',
    header: 'Commit',
    sortable: true,
    sortValue: (source) => source.commit ?? '',
    cell: (source) =>
      source.commit ? (
        <Ref
          value={source.commit}
          kind="commit"
          headline={source.commitMessage}
        />
      ) : (
        <span className="text-muted-foreground">none</span>
      ),
  },
  {
    id: 'builds',
    header: 'Builds',
    align: 'end',
    mono: true,
    sortable: true,
    sortValue: (source) => source.builds,
    cell: (source) => source.builds,
  },
  {
    id: 'retention',
    header: 'Retention',
    sortable: true,
    sortValue: (source) => source.retention,
    cell: (source) => (
      <Badge tone={source.retention === 'durable' ? 'success' : 'idle'}>
        {source.retention}
      </Badge>
    ),
  },
  {
    id: 'fetchable',
    header: 'Fetchable',
    sortable: true,
    sortValue: (source) => (source.fetchable ? 1 : 0),
    cell: (source) =>
      source.fetchable ? (
        <span className="text-muted-foreground">yes</span>
      ) : (
        <Badge tone="warning">unfetchable</Badge>
      ),
  },
  {
    id: 'age',
    header: 'Staged',
    align: 'end',
    sortable: true,
    sortValue: (source) => source.at,
    cell: (source) => (
      <Timestamp at={source.at} className="font-mono text-muted-foreground" />
    ),
  },
];

export function SourceLedger({
  sources,
  limit,
  onNavigate,
}: {
  readonly sources: readonly SourceListItem[];
  readonly limit: number;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <Page>
      <SupplyChainTabs current="sources" onNavigate={onNavigate} />
      <PageHeader
        eyebrow="Source ledger"
        title="Sources"
        description="Every immutable bundle staged before a builder could fetch it, newest first. A Source plus a Build is an Artifact; the one Source that deploys as-is is an uploaded archive of finished output."
      />
      <LedgerExplorer
        columns={COLUMNS}
        rows={sources}
        rowKey={(source) => source.digest}
        rowSearch={(source) =>
          `${source.digest} ${source.app} ${source.component} ${source.origin} ${source.repository ?? ''} ${source.commit ?? ''} ${source.location ?? ''} ${source.retention} ${source.fetchable ? 'fetchable' : 'unfetchable'} ${source.commitMessage ?? ''} ${source.commitAuthor ?? ''}`
        }
        filterPlaceholder={`Filter ${sources.length} Sources…`}
        caption="Sources, newest first"
        inspectorLabel={(source) => `Source ${shortDigest(source.digest)}`}
        empty={
          <EmptyState icon={<PackageOpen />} title="Nothing has been staged.">
            Uploading an archive or connecting a repository is what stages the
            first Source.
          </EmptyState>
        }
        renderInspector={(source) => (
          <>
            <Eyebrow>Source / {shortDigest(source.digest)}</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-title font-semibold tracking-tight">
                {source.app} / {source.component}
              </h2>
              <Badge tone={source.retention === 'durable' ? 'success' : 'idle'}>
                {source.retention}
              </Badge>
              {source.supplied ? (
                <Badge tone="accent">supplied artifact</Badge>
              ) : null}
              {!source.fetchable ? (
                <Badge tone="warning">no builder can fetch this</Badge>
              ) : null}
            </div>
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
              {source.origin === 'repo'
                ? `Fetched once from ${source.repository ?? 'its repository'} and staged whole.`
                : 'Uploaded and staged whole.'}{' '}
              {source.supplied
                ? 'It is finished output: no builder ran over it, and it deploys as it stands.'
                : 'Every Build dispatched from it was handed these exact bytes.'}
            </p>
            <DefinitionGrid
              entries={[
                {
                  label: 'Digest',
                  value: <Ref value={source.digest} kind="digest" />,
                  title: source.digest,
                  mono: true,
                },
                { label: 'Origin', value: source.origin },
                {
                  label: 'Commit',
                  value: source.commit ? (
                    <Ref value={source.commit} kind="commit" />
                  ) : (
                    'no commit'
                  ),
                  title: source.commit ?? undefined,
                  mono: true,
                },
                ...(source.commitMessage
                  ? [{ label: 'Message', value: source.commitMessage }]
                  : []),
                ...(source.commitAuthor
                  ? [
                      {
                        label: 'Author',
                        value: source.commitAuthoredAt ? (
                          <>
                            {source.commitAuthor},{' '}
                            <Timestamp at={source.commitAuthoredAt} />
                          </>
                        ) : (
                          source.commitAuthor
                        ),
                        title: source.commitAuthoredAt ?? undefined,
                      },
                    ]
                  : []),
                {
                  label: 'Staged',
                  value: <Timestamp at={source.at} />,
                  title: source.at,
                  mono: true,
                },
                {
                  label: 'Location',
                  value: source.location ?? 'none recorded',
                  mono: true,
                },
                { label: 'Builds', value: String(source.builds) },
              ]}
            />
            <div className="mt-6 flex flex-wrap gap-2">
              <Button
                onClick={() => onNavigate(`/builds/${source.latestBuildId}`)}
              >
                Latest Build
              </Button>
              <Button
                variant="outline"
                onClick={() => onNavigate(`/apps/${source.app}`)}
              >
                Open App
              </Button>
            </div>
          </>
        )}
      />
      {sources.length === limit ? (
        <p className="text-center text-caption text-muted-foreground">
          Showing the newest {limit} Sources. Older ones are reachable from the
          App they belong to.
        </p>
      ) : null}
    </Page>
  );
}

/** Read once: a Source is immutable, but its Builds count is as of load. */
export function SourcesScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const read = useRead([['listSources', {}]], null);

  if (read.type === 'loading') return <LedgerSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Sources"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [listed] = read.value;
  return (
    <SourceLedger
      sources={listed.sources}
      limit={listed.limit}
      onNavigate={onNavigate}
    />
  );
}
