/**
 * One Datastore's screen: its stored facts, and the far side's object as the
 * API server holds it at load. Every act on a Datastore lives on the ledger.
 */
import { Database } from 'lucide-react';
import type { DatastoreDetailView } from '../../../commands/views.ts';
import { DefinitionGrid } from '../../components/object-explorer.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Declaration } from '../../ui/declaration.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { DetailSkeleton, ScreenFailure, ScreenNotFound } from '../screen.tsx';
import { deployTone } from './deploys.tsx';

const CONNECTION_VARIABLE = {
  postgres: 'DATABASE_URL',
  valkey: 'REDIS_URL',
} as const;

/** Why there is no object. Only an unreadable one is a fault. */
function absence(datastore: DatastoreDetailView): string {
  if (datastore.objectError !== undefined) {
    return `${datastore.target} could not be read: ${datastore.objectError}`;
  }
  if (datastore.provenance === 'external') {
    return 'Externally authored — Spindrift provisioned nothing, so there is no object it can read.';
  }
  if (!datastore.provisioned) {
    return 'Nothing has been provisioned yet, so there is no object to read.';
  }
  return `${datastore.target} answers with no object of this kind.`;
}

export function DatastoreDetail({
  datastore,
  onNavigate,
}: {
  readonly datastore: DatastoreDetailView;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={`Datastore / ${datastore.engine}`}
        title={datastore.name}
        description={
          <>
            {datastore.provenance === 'managed'
              ? `Provisioned on ${datastore.target}.`
              : `An externally authored connection, recorded against ${datastore.target}.`}{' '}
            {datastore.attachedTo
              ? `Attached to ${datastore.attachedTo} — the connection arrives as ${CONNECTION_VARIABLE[datastore.engine]} on its next Deploy.`
              : 'Unattached: nothing reads through it yet.'}
          </>
        }
        actions={
          <>
            {/* By id: two Apps may share a name. */}
            {datastore.appId !== null ? (
              <Button
                variant="outline"
                onClick={() => onNavigate(`/apps/${datastore.appId}`)}
              >
                Open App
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => onNavigate('/datastores')}>
              All Datastores
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={datastore.attachedTo ? 'success' : 'idle'}>
          {datastore.engine}
        </Badge>
        <Badge tone={deployTone(datastore.phase)}>
          {datastore.phase.toLowerCase()}
        </Badge>
      </div>
      <DefinitionGrid
        entries={[
          { label: 'Engine', value: datastore.engine },
          { label: 'Provenance', value: datastore.provenance },
          { label: 'Target', value: datastore.target },
          { label: 'App', value: datastore.attachedTo ?? 'unattached' },
          { label: 'Phase', value: datastore.phase.toLowerCase() },
          {
            label: 'Provisioned',
            value: datastore.provisioned ? 'yes' : 'no',
          },
          {
            label: 'Arrives as',
            value: CONNECTION_VARIABLE[datastore.engine],
            mono: true,
          },
          {
            label: 'Created',
            value: <Timestamp at={datastore.at} when={datastore.when} />,
            title: datastore.at,
            mono: true,
          },
          ...(datastore.detail
            ? [{ label: 'Detail', value: datastore.detail }]
            : []),
        ]}
      />
      {datastore.object === null ? (
        <EmptyState icon={<Database />} title="No object to show.">
          {absence(datastore)}
        </EmptyState>
      ) : (
        <Declaration
          title="Runtime configuration"
          label={`${datastore.engine} object`}
          note={`Read from ${datastore.target} just now — the object as the API server holds it, not what Spindrift asked for. Its status is where a Datastore that is not LIVE says why.`}
          text={datastore.object}
        />
      )}
    </Page>
  );
}

/** Never re-reads: nothing on this screen changes a Datastore. */
export function DatastoreScreen({
  datastoreId,
  onNavigate,
}: {
  datastoreId: string;
  onNavigate: (path: string) => void;
}) {
  const read = useRead([['getDatastore', { datastoreId }]] as const, null, [
    datastoreId,
  ]);

  if (read.type === 'loading') return <DetailSkeleton />;
  if (read.type === 'error') {
    // A malformed id fails validation, and to a reader it is also not found.
    return read.failure.code === 'NOT_FOUND' ||
      read.failure.code === 'INVALID_INPUT' ? (
      <ScreenNotFound
        title="Datastore not found"
        message={read.failure.message}
        onNavigate={onNavigate}
      />
    ) : (
      <ScreenFailure
        title="Failed to load Datastore"
        message={read.failure.message}
        width="reading"
        onRetry={read.reload}
      />
    );
  }
  const [{ datastore }] = read.value;
  return <DatastoreDetail datastore={datastore} onNavigate={onNavigate} />;
}
