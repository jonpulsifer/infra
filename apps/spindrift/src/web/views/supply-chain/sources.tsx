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
 * as indistinguishable from one that can.
 */
import type { OutputOf } from '../../client.ts';
import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { SupplyChainTabs } from './tabs.tsx';

export type SourceListItem = OutputOf<'listSources'>['sources'][number];

/** `sha256:abc…` — enough to recognise, short enough to sit in a row. */
export function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.split(':');
  if (hex === undefined) return digest;
  return `${algorithm}:${hex.slice(0, 12)}`;
}

export function SourceLedger({
  sources,
  limit,
  onNavigate,
}: {
  readonly sources: readonly SourceListItem[];
  readonly limit: number;
  readonly onNavigate: (path: string) => void;
}) {
  const byId = new Map(sources.map((source) => [source.digest, source]));
  const items: ExplorerItem[] = sources.map((source) => ({
    id: source.digest,
    title: shortDigest(source.digest),
    detail: `${source.app} / ${source.component}`,
    status: source.fetchable ? source.retention : 'unfetchable',
    tone: !source.fetchable
      ? 'warning'
      : source.retention === 'durable'
        ? 'success'
        : 'idle',
    at: source.at,
    search: `${source.origin} ${source.repository ?? ''} ${source.commit ?? ''} ${source.location ?? ''}`,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <SupplyChainTabs current="sources" onNavigate={onNavigate} />
      <ExplorerPageHeader
        eyebrow="Source ledger"
        title="Sources"
        description="Every immutable bundle staged before a builder could fetch it, newest first. A Source plus a Build is an Artifact; the one Source that deploys as-is is an uploaded archive of finished output."
      />
      <ObjectExplorer
        items={items}
        filterPlaceholder={`Filter ${sources.length} Sources…`}
        empty={
          <div className="rounded-sm border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            Nothing has been staged yet. Uploading an archive or connecting a
            repository is what stages the first Source.
          </div>
        }
        renderInspector={(item) => {
          const source = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>Source / {shortDigest(source.digest)}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {source.app} / {source.component}
                </h2>
                <Badge
                  tone={source.retention === 'durable' ? 'success' : 'idle'}
                >
                  {source.retention}
                </Badge>
                {source.supplied ? (
                  <Badge tone="accent">supplied artifact</Badge>
                ) : null}
                {!source.fetchable ? (
                  <Badge tone="warning">no builder can fetch this</Badge>
                ) : null}
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {source.origin === 'repo'
                  ? `Fetched once from ${source.repository ?? 'its repository'} and staged whole.`
                  : 'Uploaded and staged whole.'}{' '}
                {source.supplied
                  ? 'It is finished output: no builder ran over it, and it deploys as it stands.'
                  : 'Every Build dispatched from it was handed these exact bytes.'}
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'Digest', value: source.digest, mono: true },
                  { label: 'Origin', value: source.origin },
                  {
                    label: 'Commit',
                    value: source.commit?.slice(0, 12) ?? 'no commit',
                    mono: true,
                  },
                  { label: 'Retention', value: source.retention },
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
          );
        }}
      />
      {sources.length === limit ? (
        <p className="text-center text-xs text-muted-foreground">
          Showing the newest {limit} Sources. Older ones are reachable from the
          App they belong to.
        </p>
      ) : null}
    </div>
  );
}
