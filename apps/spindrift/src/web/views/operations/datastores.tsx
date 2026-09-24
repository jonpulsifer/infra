/**
 * The Datastores ledger: every store this installation holds, attached or not.
 * Create is in the header; Attach, Detach and Destroy are in the inspector.
 */
import { Database } from 'lucide-react';
import { useState } from 'react';
import type {
  AppListItem,
  DatastoreListItem,
  DatastoreVesselOption,
} from '../../../commands/views.ts';
import { command } from '../../client.ts';
import {
  DefinitionGrid,
  LedgerExplorer,
} from '../../components/object-explorer.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import type { Column } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Field } from '../../ui/field.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { LedgerSkeleton, ScreenFailure } from '../screen.tsx';
import { deployTone } from './deploys.tsx';

/** Detach or Destroy, by id. A refusal carries the command's own message. */
export type DatastoreAct = (
  datastoreId: string,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export type AttachLedgerDatastore = (
  datastoreId: string,
  appId: string,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export type CreateLedgerDatastore = (create: {
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
  readonly vesselId: string;
}) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

const COLUMNS: readonly Column<DatastoreListItem>[] = [
  {
    id: 'name',
    header: 'Name',
    sortable: true,
    sortValue: (datastore) => datastore.name,
    cell: (datastore) => (
      <span className="truncate font-medium">{datastore.name}</span>
    ),
  },
  {
    id: 'engine',
    header: 'Engine',
    sortable: true,
    sortValue: (datastore) => datastore.engine,
    cell: (datastore) => (
      <Badge tone={datastore.attachedTo ? 'success' : 'idle'}>
        {datastore.engine}
      </Badge>
    ),
  },
  {
    id: 'provenance',
    header: 'Provenance',
    sortable: true,
    sortValue: (datastore) => datastore.provenance,
    cell: (datastore) => datastore.provenance,
  },
  {
    id: 'target',
    header: 'Vessel',
    sortable: true,
    sortValue: (datastore) => datastore.target,
    cell: (datastore) => datastore.target,
  },
  {
    id: 'attached',
    header: 'App',
    sortable: true,
    sortValue: (datastore) => datastore.attachedTo ?? '',
    cell: (datastore) =>
      datastore.attachedTo ? (
        <span className="truncate">{datastore.attachedTo}</span>
      ) : (
        <span className="text-muted-foreground">unattached</span>
      ),
  },
  {
    id: 'phase',
    header: 'Phase',
    sortable: true,
    sortValue: (datastore) => datastore.phase,
    cell: (datastore) => (
      <Badge tone={deployTone(datastore.phase)}>
        {datastore.phase.toLowerCase()}
      </Badge>
    ),
  },
  {
    id: 'age',
    header: 'Created',
    align: 'end',
    sortable: true,
    sortValue: (datastore) => datastore.at,
    cell: (datastore) => (
      <Timestamp
        at={datastore.at}
        when={datastore.when}
        className="font-mono text-muted-foreground"
      />
    ),
  },
];

/**
 * Attach and Destroy for an unattached row, Detach for an attached one. Keyed
 * by id at the call site, so `busy` and `refusal` reset with the selection.
 */
function DatastoreRowActions({
  datastore,
  apps,
  onAttach,
  onDetach,
  onDestroy,
}: {
  readonly datastore: DatastoreListItem;
  readonly apps: readonly AppListItem[];
  readonly onAttach: AttachLedgerDatastore;
  readonly onDetach: DatastoreAct;
  readonly onDestroy: DatastoreAct;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [appId, setAppId] = useState('');
  const chosen = appId === '' ? apps[0]?.id : appId;

  const act = (run: DatastoreAct) => {
    setBusy(true);
    setRefusal(null);
    void run(datastore.id).then((result) => {
      setBusy(false);
      if (!result.ok) setRefusal(result.message);
    });
  };

  return (
    <div className="mt-6">
      {refusal ? (
        <p className="mb-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {datastore.appId === null && apps.length > 0 ? (
          <>
            <Select
              id="attach-app"
              value={chosen ?? ''}
              disabled={busy}
              options={apps.map((app) => ({ value: app.id, label: app.name }))}
              onChange={setAppId}
            />
            <Button
              variant="outline"
              disabled={busy || chosen === undefined}
              onClick={() => {
                if (chosen === undefined) return;
                setBusy(true);
                setRefusal(null);
                void onAttach(datastore.id, chosen).then((result) => {
                  setBusy(false);
                  if (!result.ok) setRefusal(result.message);
                });
              }}
            >
              Attach
            </Button>
          </>
        ) : null}
        {datastore.appId !== null ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => act(onDetach)}
          >
            Detach
          </Button>
        ) : null}
        {datastore.appId === null ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => act(onDestroy)}
          >
            Destroy
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Select({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-9 w-full rounded-sm border border-input bg-background px-3 font-mono text-body text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Offers only the engines the selected Vessel serves. The engine is derived
 * from the selection, so switching Vessel never leaves an unserved one chosen.
 */
function NewDatastoreForm({
  vessels,
  onCreate,
  onDone,
}: {
  readonly vessels: readonly DatastoreVesselOption[];
  readonly onCreate: CreateLedgerDatastore;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [vesselId, setVesselId] = useState(vessels[0]?.vesselId ?? '');
  const [chosenEngine, setChosenEngine] = useState<'postgres' | 'valkey'>(
    'postgres',
  );
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'created' }
    | { readonly kind: 'refused'; readonly message: string }
    | null
  >(null);

  const vessel = vessels.find((row) => row.vesselId === vesselId) ?? vessels[0];
  const engines = vessel?.engines ?? [];
  const engine = engines.includes(chosenEngine) ? chosenEngine : engines[0];

  const save = async () => {
    if (vessel === undefined || engine === undefined) return;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onCreate({
        name: name.trim(),
        engine,
        vesselId: vessel.vesselId,
      });
      if (result.ok) {
        setOutcome({ kind: 'created' });
        setName('');
      } else {
        setOutcome({ kind: 'refused', message: result.message });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-soft p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          name="datastore-name"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="primary"
        />
        <Field name="datastore-vessel" label="Vessel">
          <Select
            id="datastore-vessel"
            value={vessel?.vesselId ?? ''}
            disabled={saving}
            options={vessels.map((row) => ({
              value: row.vesselId,
              label: row.label,
            }))}
            onChange={setVesselId}
          />
        </Field>
        <Field
          name="datastore-engine"
          label="Engine"
          hint={
            engine === 'postgres'
              ? 'Arrives as DATABASE_URL'
              : 'Arrives as REDIS_URL'
          }
        >
          <Select
            id="datastore-engine"
            value={engine ?? ''}
            disabled={saving}
            options={engines.map((served) => ({
              value: served,
              label: served,
            }))}
            onChange={(value) =>
              setChosenEngine(value === 'valkey' ? 'valkey' : 'postgres')
            }
          />
        </Field>
      </div>
      {outcome?.kind === 'refused' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === 'created' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          Created, unattached. It provisions in the background — the row says
          how far it has got — and attaching it to an App is `attachDatastore`
          over the API.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving || name.trim() === '' || engine === undefined}
          onClick={() => {
            void save();
          }}
        >
          {saving ? 'Creating…' : 'Create Datastore'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome?.kind === 'created' ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}

export function DatastoreLedger({
  datastores,
  vessels,
  apps = [],
  onNavigate,
  onCreate,
  onAttach,
  onDetach,
  onDestroy,
}: {
  readonly datastores: readonly DatastoreListItem[];
  readonly vessels: readonly DatastoreVesselOption[];
  readonly apps?: readonly AppListItem[];
  readonly onNavigate: (path: string) => void;
  readonly onCreate: CreateLedgerDatastore;
  readonly onAttach: AttachLedgerDatastore;
  readonly onDetach: DatastoreAct;
  readonly onDestroy: DatastoreAct;
}) {
  const [adding, setAdding] = useState(false);
  // With no Vessel serving an engine, a create form has nothing to target.
  const canCreate = vessels.length > 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Attached resources"
        title="Datastores"
        description="Every Postgres and Valkey Datastore this installation holds, attached or not. Create one here in any Vessel that serves the engine."
        {...(canCreate
          ? {
              actions: (
                <Button
                  variant="outline"
                  onClick={() => setAdding((current) => !current)}
                >
                  {adding ? 'Close' : 'Create Datastore'}
                </Button>
              ),
            }
          : {})}
      />
      {canCreate && adding ? (
        <NewDatastoreForm
          vessels={vessels}
          onCreate={onCreate}
          onDone={() => setAdding(false)}
        />
      ) : null}
      <LedgerExplorer
        columns={COLUMNS}
        rows={datastores}
        rowKey={(datastore) => datastore.id}
        rowSearch={(datastore) =>
          `${datastore.name} ${datastore.engine} ${datastore.provenance} ${datastore.target} ${datastore.attachedTo ?? 'unattached'} ${datastore.phase}`
        }
        filterPlaceholder={`Filter ${datastores.length} Datastores…`}
        caption="Datastores, newest first"
        inspectorLabel={(datastore) => `Datastore ${datastore.name}`}
        empty={
          <EmptyState icon={<Database />} title="No Datastores exist yet.">
            {canCreate
              ? 'Create one in any Vessel that serves the engine.'
              : 'No connected Vessel serves Postgres or Valkey, so there is nowhere to create one yet.'}
          </EmptyState>
        }
        renderInspector={(datastore) => (
          <>
            <Eyebrow>Datastore / {datastore.engine}</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h2 className="text-title font-semibold tracking-tight">
                {datastore.name}
              </h2>
              <Badge tone={datastore.attachedTo ? 'success' : 'idle'}>
                {datastore.engine}
              </Badge>
              <Badge tone={deployTone(datastore.phase)}>
                {datastore.phase.toLowerCase()}
              </Badge>
            </div>
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted-foreground">
              {datastore.provenance === 'managed'
                ? `Provisioned on ${datastore.target}.`
                : `An externally authored connection, recorded against ${datastore.target}.`}{' '}
              {datastore.attachedTo
                ? `Attached to ${datastore.attachedTo} — the connection arrives on its next Deploy.`
                : 'Unattached: nothing reads through it yet.'}
            </p>
            <DefinitionGrid
              entries={[
                { label: 'Engine', value: datastore.engine },
                { label: 'Provenance', value: datastore.provenance },
                { label: 'Vessel', value: datastore.target },
                { label: 'App', value: datastore.attachedTo ?? 'unattached' },
                { label: 'Phase', value: datastore.phase.toLowerCase() },
                {
                  label: 'Provisioned',
                  value: datastore.provisioned ? 'yes' : 'no',
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
            <div className="mt-6 flex flex-wrap gap-2">
              <Button onClick={() => onNavigate(`/datastores/${datastore.id}`)}>
                Open Datastore
              </Button>
              {/* By id: two Apps may share a name. */}
              {datastore.appId !== null ? (
                <Button
                  variant="outline"
                  onClick={() => onNavigate(`/apps/${datastore.appId}`)}
                >
                  Open App
                </Button>
              ) : null}
            </div>
            <DatastoreRowActions
              key={datastore.id}
              datastore={datastore}
              apps={apps}
              onAttach={onAttach}
              onDetach={onDetach}
              onDestroy={onDestroy}
            />
          </>
        )}
      />
    </Page>
  );
}

/** Owns the act handlers, because a successful act re-reads this list. */
export function DatastoresScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const read = useRead(
    [
      ['listDatastores', {}],
      // For the attach picker.
      ['listApps', {}],
    ],
    null,
  );

  const handleCreate: CreateLedgerDatastore = async (create) => {
    try {
      const result = await command('createDatastore', {
        name: create.name,
        engine: create.engine,
        vesselId: create.vesselId,
        // The schema's default. `InputOf` is the schema's output type, where a
        // `.default()` field is required.
        storageGiB: 10,
      });
      // A refused create leaves no row, so there is nothing to re-read.
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error
            ? cause.message
            : 'Creating the Datastore failed',
      };
    }
  };

  const handleAttach: AttachLedgerDatastore = async (datastoreId, appId) => {
    try {
      const result = await command('attachDatastore', { datastoreId, appId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Attaching failed',
      };
    }
  };

  const handleDetach: DatastoreAct = async (datastoreId) => {
    try {
      const result = await command('detachDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Detaching failed',
      };
    }
  };

  const handleDestroy: DatastoreAct = async (datastoreId) => {
    try {
      const result = await command('destroyDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Destroying failed',
      };
    }
  };

  if (read.type === 'loading') return <LedgerSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Datastores"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [listed, apps] = read.value;
  return (
    <DatastoreLedger
      datastores={listed.datastores}
      vessels={listed.vessels}
      apps={apps.apps}
      onNavigate={onNavigate}
      onCreate={handleCreate}
      onAttach={handleAttach}
      onDetach={handleDetach}
      onDestroy={handleDestroy}
    />
  );
}
