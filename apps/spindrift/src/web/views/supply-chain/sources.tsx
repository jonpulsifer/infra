/**
 * Sources — the immutable bytes every Build starts from.
 *
 * The first term of §2's chain, and the one that had no surface. It lived as a
 * "Bundles" section on a Settings screen about storage, beside the buckets it
 * is staged into — which put an object of the product inside its own
 * configuration and left "bundle" meaning both an input and, for §4's supplied
 * artifact, an output.
 *
 * **One row is one digest, not one Build.** The same staged bytes are
 * dispatched once per target shape, so a per-Build reading showed the same
 * Source twice; `builds` on the row is how many were dispatched from it.
 *
 * The two facts worth reading on a row are `retention` and `fetchable`, and
 * they are separate on purpose. Retention is what was promised — an upload is
 * durable, a repository fetch ephemeral. Fetchable is whether a build route
 * could be handed this location at all: `upload://` is deliberately not a URL,
 * and a listing that did not say so would show a Source that cannot be built
 * as indistinguishable from one that can. Both were one word in a single status
 * slot before, which meant a `durable` Source no builder can fetch could only
 * report one of the two things wrong with it.
 *
 * `origin` and `commit` were in the Explorer's invisible `search` string: an
 * operator could filter for a repository and never see which rows came from
 * one. And every row carried an `at` that never reached the screen, because the
 * old row only drew a time when the server had also computed a relative phrase
 * — which `listSources` does not. {@link Timestamp} needs only the instant.
 */
import { PackageOpen } from 'lucide-react';
import type { OutputOf } from '../../client.ts';
import {
  DefinitionGrid,
  LedgerExplorer,
} from '../../components/object-explorer.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { Ref } from '../../ui/copy.tsx';
import type { Column } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { SupplyChainTabs } from './tabs.tsx';

export type SourceListItem = OutputOf<'listSources'>['sources'][number];

/**
 * `sha256:abc…` — enough to recognise, short enough to sit in a heading.
 *
 * Kept beside {@link Ref}, which shortens the same way but renders a control.
 * A heading and an accessible name are text, and a copy button inside either is
 * a control nobody can reach by reading.
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
        <Ref value={source.commit} kind="commit" />
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
    // The warning is the whole reason this column exists: a Source no build
    // route can be handed is a dead end, and it used to look like every other
    // row until somebody clicked it.
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
          `${source.digest} ${source.app} ${source.component} ${source.origin} ${source.repository ?? ''} ${source.commit ?? ''} ${source.location ?? ''} ${source.retention} ${source.fetchable ? 'fetchable' : 'unfetchable'}`
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
