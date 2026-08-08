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
 * Signature and provenance are columns rather than a colour. The row used to
 * encode `signed` as the difference between an `accent` dot and an `idle` one,
 * with no legend anywhere — so "which of these is unsigned" was a question
 * about a shade of grey, on the one screen whose subject is supply-chain
 * evidence. §16's verified level and core's own signature are two separate
 * claims and they get two separate cells; an unsigned row is `warning` because
 * that is the one an operator has to decide about.
 *
 * The full provenance envelope stays on the Build, beside the evidence that
 * produced it — a level here that was not derived from a document there would
 * be a claim about a claim.
 */
import { Boxes } from 'lucide-react';
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
import { shortDigest } from './sources.tsx';
import { SupplyChainTabs } from './tabs.tsx';

export type ArtifactListItem = OutputOf<'listArtifacts'>['artifacts'][number];

const COLUMNS: readonly Column<ArtifactListItem>[] = [
  {
    id: 'digest',
    header: 'Digest',
    sortable: true,
    sortValue: (artifact) => artifact.digest,
    cell: (artifact) => <Ref value={artifact.digest} kind="digest" />,
  },
  {
    id: 'app',
    header: 'App / component',
    sortable: true,
    sortValue: (artifact) => `${artifact.app}/${artifact.component}`,
    cell: (artifact) => (
      <span className="truncate">
        {artifact.app} <span className="text-muted-foreground">/</span>{' '}
        {artifact.component}
      </span>
    ),
  },
  {
    id: 'type',
    header: 'Type',
    sortable: true,
    sortValue: (artifact) => artifact.type,
    cell: (artifact) => (
      <span className="truncate">
        {artifact.type}
        {artifact.supplied ? (
          <span className="text-muted-foreground"> · supplied</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'provenance',
    header: 'Provenance',
    sortable: true,
    sortValue: (artifact) => artifact.provenanceLevel ?? -1,
    cell: (artifact) =>
      artifact.provenanceLevel === null ? (
        <span className="text-muted-foreground">not verified</span>
      ) : (
        `SLSA L${artifact.provenanceLevel}`
      ),
  },
  {
    id: 'signed',
    header: 'Signature',
    sortable: true,
    sortValue: (artifact) => (artifact.signed ? 0 : 1),
    cell: (artifact) =>
      artifact.signed ? (
        <Badge tone="success">signed</Badge>
      ) : (
        <Badge tone="warning">unsigned</Badge>
      ),
  },
  {
    id: 'deploys',
    header: 'Placed',
    sortable: true,
    sortValue: (artifact) => artifact.deploys,
    cell: (artifact) =>
      artifact.deploys > 0 ? (
        `${artifact.deploys} deploy${artifact.deploys === 1 ? '' : 's'}`
      ) : (
        <span className="text-muted-foreground">never placed</span>
      ),
  },
  {
    id: 'age',
    header: 'Produced',
    align: 'end',
    sortable: true,
    sortValue: (artifact) => artifact.at,
    cell: (artifact) => (
      <Timestamp at={artifact.at} className="font-mono text-muted-foreground" />
    ),
  },
];

export function ArtifactLedger({
  artifacts,
  limit,
  onNavigate,
}: {
  readonly artifacts: readonly ArtifactListItem[];
  readonly limit: number;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <Page>
      <SupplyChainTabs current="artifacts" onNavigate={onNavigate} />
      <PageHeader
        eyebrow="Artifact ledger"
        title="Artifacts"
        description="What a Build produced, newest first. An Artifact is immutable and outlives the attempt that made it — the same digest is what every Deploy of it places."
      />
      <LedgerExplorer
        columns={COLUMNS}
        rows={artifacts}
        rowKey={(artifact) => `artifact:${artifact.buildId}`}
        rowSearch={(artifact) =>
          `${artifact.digest} ${artifact.app} ${artifact.component} ${artifact.type} ${artifact.commit} ${artifact.refs.join(' ')} ${artifact.signed ? 'signed' : 'unsigned'} ${artifact.deploys === 0 ? 'never placed' : 'placed'}`
        }
        filterPlaceholder={`Filter ${artifacts.length} Artifacts…`}
        caption="Artifacts, newest first"
        inspectorLabel={(artifact) =>
          `Artifact ${shortDigest(artifact.digest)}`
        }
        empty={
          <EmptyState icon={<Boxes />} title="No Artifact exists yet.">
            A Build that succeeds produces the first one.
          </EmptyState>
        }
        renderInspector={(artifact) => (
          <>
            <Eyebrow>Artifact / {shortDigest(artifact.digest)}</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-title font-semibold tracking-tight">
                {artifact.app} / {artifact.component}
              </h2>
              <Badge tone="idle">{artifact.type}</Badge>
              {artifact.signed ? <Badge tone="success">signed</Badge> : null}
              {artifact.supplied ? <Badge tone="accent">supplied</Badge> : null}
              {artifact.deploys === 0 ? (
                <Badge tone="idle">never placed</Badge>
              ) : null}
            </div>
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
              {artifact.supplied
                ? 'Uploaded finished output: no builder ran, and the staged digest is the artifact.'
                : `Built from commit ${artifact.commit.slice(0, 12)} by Build #${artifact.buildId}.`}{' '}
              {artifact.deploys > 0
                ? `Placed by ${artifact.deploys} Deploy${artifact.deploys === 1 ? '' : 's'}.`
                : 'Nothing has placed it.'}
            </p>
            <DefinitionGrid
              entries={[
                {
                  label: 'Digest',
                  value: <Ref value={artifact.digest} kind="digest" />,
                  title: artifact.digest,
                  mono: true,
                },
                { label: 'Type', value: artifact.type },
                {
                  label: 'Source',
                  value: artifact.sourceDigest ? (
                    <Ref value={artifact.sourceDigest} kind="digest" />
                  ) : (
                    'none recorded'
                  ),
                  title: artifact.sourceDigest ?? undefined,
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
                {
                  label: 'Produced',
                  value: <Timestamp at={artifact.at} />,
                  title: artifact.at,
                  mono: true,
                },
              ]}
            />
            {artifact.refs.length > 0 ? (
              <section className="mt-6 border-t border-border pt-5">
                <Eyebrow>Pushed to</Eyebrow>
                <ul className="mt-2 flex flex-col gap-1">
                  {artifact.refs.map((ref) => (
                    <li
                      key={ref}
                      className="font-mono text-caption text-subtle"
                    >
                      {ref}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-2">
              <Button onClick={() => onNavigate(`/builds/${artifact.buildId}`)}>
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
        )}
      />
      {artifacts.length === limit ? (
        <p className="text-center text-caption text-muted-foreground">
          Showing the newest {limit} Artifacts. Older ones are reachable from
          the App they belong to.
        </p>
      ) : null}
    </Page>
  );
}
