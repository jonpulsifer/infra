/**
 * One Datastore's screen — where a row goes when it is pressed.
 *
 * §11 makes a Datastore top-level and the ledger gave it a list; this is the
 * other half. Every screen that names a Datastore — the ledger's inspector,
 * the App workspace's attached-resources card — held the same six stored facts
 * and nothing about the thing itself, so the only way to answer "what is this
 * cluster actually configured as" was `kubectl`.
 *
 * **The object is the far side's, and the page says so.** It is the API
 * server's document, read at load: spec, the defaults the operator filled in,
 * and the `status` that is where a WAITING Datastore's reason lives. Nothing
 * here composes a manifest — `getDatastore`'s note argues why core could not
 * compose an honest one — so what is on screen is what is running, drift and
 * all.
 *
 * **Read, not act.** Attach lives on the workspace of the App it binds to, and
 * Create, Detach and Destroy live on the ledger, which is where a reader who
 * came to act already is. A second set of buttons here would be a second place
 * for a refusal to come back to.
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

/**
 * Which variable the connection arrives on, as `Datastores` on the workspace
 * states it for its whole section. Fixed by engine, chosen by nothing, and the
 * one runtime fact a developer reading this page came for.
 */
const CONNECTION_VARIABLE = {
  postgres: 'DATABASE_URL',
  valkey: 'REDIS_URL',
} as const;

/**
 * What the object pane says when there is no object.
 *
 * Four absences, four sentences, because they are four different situations
 * and only one of them is a fault. `getDatastore` distinguishes them on the
 * way out; collapsing them here to "nothing to show" would tell an operator
 * whose cluster is unreachable the same thing it tells one whose Datastore was
 * never provisioned.
 */
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
              : 'Unattached: nothing reads through it yet. Attaching is done from the App’s workspace.'}
          </>
        }
        actions={
          <>
            {/*
              By id, never by the name beside it — the ledger's inspector makes
              the same point: two Apps may share a name and `getAppWorkspace`
              resolves either, so a name opens whichever the database answered
              with.
            */}
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

/**
 * One Datastore, by id (§11).
 *
 * A `null` cadence rather than a poll: every act on a Datastore is on another
 * screen — the ledger's, or the workspace of the App it attaches to — so
 * nothing this one does can invalidate what it is showing. The far-side object
 * is read once with the row, and the retry is for the load that failed.
 */
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
    // A malformed id fails input validation rather than the lookup, and "there
    // is no Datastore with that id" is what both mean to a reader who followed
    // a stale link.
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
