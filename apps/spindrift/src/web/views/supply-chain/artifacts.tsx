/**
 * Artifacts — what the Builds left behind, and what the Deploys place.
 *
 * The noun between the two acts: **Source + Build = Artifact**, then
 * **Artifact + Config = Deploy**. A Build is an attempt with a status, a runner
 * and a log; the Artifact is immutable and outlives it, which is what makes
 * §2's "one Build → many Deploys" — and rollback without rebuilding — mean
 * anything. Reading this as a second view of the Builds ledger is exactly the
 * conflation the separation exists to undo.
 *
 * `deploys` is the column the screen is opened for: an Artifact nothing has
 * placed is a build that was never released, and that is not visible anywhere
 * a Build's status is the only thing on the row.
 *
 * Provenance shows the level core actually verified and whether core signed it
 * (§16). The full envelope stays on the Build, beside the evidence that
 * produced it — a level here that was not derived from a document there would
 * be a claim about a claim.
 */
import type { OutputOf } from '../../client.ts';
import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  type ExplorerTone,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { shortDigest } from './sources.tsx';
import { SupplyChainTabs } from './tabs.tsx';

export type ArtifactListItem = OutputOf<'listArtifacts'>['artifacts'][number];

function tone(artifact: ArtifactListItem): ExplorerTone {
  if (artifact.deploys > 0) return 'success';
  return artifact.signed ? 'accent' : 'idle';
}

export function ArtifactLedger({
  artifacts,
  limit,
  onNavigate,
}: {
  readonly artifacts: readonly ArtifactListItem[];
  readonly limit: number;
  readonly onNavigate: (path: string) => void;
}) {
  const byId = new Map(
    artifacts.map((artifact) => [`artifact:${artifact.buildId}`, artifact]),
  );
  const items: ExplorerItem[] = artifacts.map((artifact) => ({
    id: `artifact:${artifact.buildId}`,
    title: shortDigest(artifact.digest),
    detail: `${artifact.app} / ${artifact.component}`,
    status:
      artifact.deploys > 0
        ? `${artifact.deploys} deploy${artifact.deploys === 1 ? '' : 's'}`
        : 'never placed',
    tone: tone(artifact),
    at: artifact.at,
    search: `${artifact.type} ${artifact.commit} ${artifact.refs.join(' ')}`,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <SupplyChainTabs current="artifacts" onNavigate={onNavigate} />
      <ExplorerPageHeader
        eyebrow="Artifact ledger"
        title="Artifacts"
        description="What a Build produced, newest first. An Artifact is immutable and outlives the attempt that made it — the same digest is what every Deploy of it places."
      />
      <ObjectExplorer
        items={items}
        filterPlaceholder={`Filter ${artifacts.length} Artifacts…`}
        empty={
          <div className="rounded-sm border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No Artifact exists yet. A Build that succeeds produces the first
            one.
          </div>
        }
        renderInspector={(item) => {
          const artifact = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>Artifact / {shortDigest(artifact.digest)}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {artifact.app} / {artifact.component}
                </h2>
                <Badge tone="idle">{artifact.type}</Badge>
                {artifact.signed ? <Badge tone="success">signed</Badge> : null}
                {artifact.supplied ? (
                  <Badge tone="accent">supplied</Badge>
                ) : null}
                {artifact.deploys === 0 ? (
                  <Badge tone="idle">never placed</Badge>
                ) : null}
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {artifact.supplied
                  ? 'Uploaded finished output: no builder ran, and the staged digest is the artifact.'
                  : `Built from commit ${artifact.commit.slice(0, 12)} by Build #${artifact.buildId}.`}{' '}
                {artifact.deploys > 0
                  ? `Placed by ${artifact.deploys} Deploy${artifact.deploys === 1 ? '' : 's'}.`
                  : 'Nothing has placed it.'}
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'Digest', value: artifact.digest, mono: true },
                  { label: 'Type', value: artifact.type },
                  {
                    label: 'Source',
                    value: artifact.sourceDigest
                      ? shortDigest(artifact.sourceDigest)
                      : 'none recorded',
                    mono: true,
                  },
                  {
                    label: 'Provenance',
                    value:
                      artifact.provenanceLevel === null
                        ? 'not verified'
                        : `SLSA L${artifact.provenanceLevel}`,
                  },
                  {
                    label: 'Signature',
                    value: artifact.signed ? 'signed by core' : 'none',
                  },
                  { label: 'Deploys', value: String(artifact.deploys) },
                ]}
              />
              {artifact.refs.length > 0 ? (
                <section className="mt-6 border-t border-border pt-5">
                  <Eyebrow>Pushed to</Eyebrow>
                  <ul className="mt-2 flex flex-col gap-1">
                    {artifact.refs.map((ref) => (
                      <li key={ref} className="font-mono text-xs text-subtle">
                        {ref}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <div className="mt-6 flex flex-wrap gap-2">
                <Button
                  onClick={() => onNavigate(`/builds/${artifact.buildId}`)}
                >
                  Open Build
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onNavigate(`/apps/${artifact.app}`)}
                >
                  Open App
                </Button>
              </div>
            </>
          );
        }}
      />
      {artifacts.length === limit ? (
        <p className="text-center text-xs text-muted-foreground">
          Showing the newest {limit} Artifacts. Older ones are reachable from
          the App they belong to.
        </p>
      ) : null}
    </div>
  );
}
