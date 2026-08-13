/**
 * Datastores — every store this installation holds, attached or not.
 *
 * §11 gives a Datastore four commands, a table, an adapter contract and two
 * backends, and until now no read path except one App's workspace — which
 * only ever showed the rows touching that App, plus every unattached one
 * repeated on every other App's workspace beside it. A Datastore is top-level
 * (§11: "attached, not a field"), and this is the screen a top-level noun
 * gets: one ledger, independent of which App a reader opened first.
 *
 * **Create lives here; attach does not.** `createDatastore` takes a name, an
 * engine and a Vessel, and no App — storage exists before anything reads it,
 * which is the whole of what "top-level, not a field" means — so the only
 * picker this form needs is the one `listDatastores` sends with the rows.
 * `attachDatastore` genuinely does bind to an App, and a global ledger has
 * none selected, so it stays on the workspace of the App it would attach to.
 * Alongside it are the two acts that take only a Datastore id: Detach and
 * Destroy, one at a time and never both, because the row already says which
 * one core would accept — `destroyDatastore` refuses while attached. That is
 * stricter than the workspace's section, which offers Destroy on every row and
 * lets the refusal come back as a sentence; here the reader has no App open to
 * detach from first, so a button whose only outcome is that refusal is worth
 * less than the one act that works.
 *
 * Not a `SupplyChainTabs` member. §2's chain is Source + Build = Artifact;
 * a Datastore is never an input to that chain or an output of it, so tabbing
 * it in beside Builds and Sources would draw a fourth stage that does not
 * exist.
 */
import { Database } from 'lucide-react';
import { useState } from 'react';
import type {
  DatastoreListItem,
  DatastoreVesselOption,
} from '../../../commands/views.ts';
import {
  DefinitionGrid,
  LedgerExplorer,
} from '../../components/object-explorer.tsx';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import type { Column } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Field } from '../../ui/field.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { deployTone } from './deploys.tsx';

/**
 * Detaching or destroying one Datastore, by id.
 *
 * One shape for both, the same reason `workspace.tsx`'s `DatastoreAct` is:
 * they take the same argument and answer the same question, and every
 * refusal either can carry is a sentence core composed rather than one
 * guessed at here.
 */
export type DatastoreAct = (
  datastoreId: string,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Creating one managed Datastore from the ledger.
 *
 * Three fields and no App, which is `createDatastore`'s own input minus the
 * size it defaults — the workspace's `CreateDatastore` is this shape with the
 * Vessel implied by the App that screen already has open, and the two stay
 * separate rather than one shared alias because the implied Vessel is exactly
 * the difference.
 */
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
 * Detach or Destroy, with the refusal a press produced — never both acts at
 * once: `appId` already says which one applies, so offering the other is
 * offering a button whose only outcome is core's refusal.
 *
 * Its own component rather than inline state in `renderInspector`, because
 * the inspector is called fresh for whichever row is selected and a `busy` /
 * `refusal` pair declared there would survive the reader picking a different
 * Datastore. Keyed by id at the call site, so switching rows starts clean.
 */
function DatastoreRowActions({
  datastore,
  onDetach,
  onDestroy,
}: {
  readonly datastore: DatastoreListItem;
  readonly onDetach: DatastoreAct;
  readonly onDestroy: DatastoreAct;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

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
      <div className="flex flex-wrap gap-2">
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

/** A `<select>` styled like the `Input` beside it, so the two do not diverge. */
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
 * Creating one managed Datastore — a name, a Vessel and an engine.
 *
 * **The engine list is the selected Vessel's, not the two the schema accepts.**
 * §3 makes Postgres and Valkey independent capabilities, so a cluster that
 * serves one and not the other is ordinary; offering both everywhere would put
 * a choice on screen whose only outcome on half the Vessels is core's "does not
 * serve" refusal. It is derived from the selection rather than corrected by an
 * effect, so switching Vessel can never leave a stale engine selected for the
 * length of a render.
 *
 * No size field, the same decision `NewDatastoreForm` makes on the workspace:
 * `storageGiB` is a defaulted command input because a developer has no basis on
 * day one for a number a resize command would own.
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
          how far it has got — and attaching it to an App is done from that
          App's workspace.
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
  onNavigate,
  onCreate,
  onDetach,
  onDestroy,
}: {
  readonly datastores: readonly DatastoreListItem[];
  readonly vessels: readonly DatastoreVesselOption[];
  readonly onNavigate: (path: string) => void;
  readonly onCreate: CreateLedgerDatastore;
  readonly onDetach: DatastoreAct;
  readonly onDestroy: DatastoreAct;
}) {
  const [adding, setAdding] = useState(false);
  // No Vessel serves an engine, so there is nothing a form here could be
  // pointed at. The button is withheld rather than shown and refused: the
  // sentence below already says what is missing, and it is a connection fact
  // about the boundary's hosting surface, not something a retry of this form
  // fixes.
  const canCreate = vessels.length > 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Attached resources"
        title="Datastores"
        description="Every Postgres and Valkey Datastore this installation holds, attached or not. Create one here in any Vessel that serves the engine; attaching it to an App stays on that App's workspace."
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
              ? 'Create one in any Vessel that serves the engine — attaching it to an App is done from that App’s workspace.'
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
              {/*
                The durable route this list's selection deliberately is not —
                `ObjectExplorer`'s note: "picking an object is inspection, not
                navigation; callers put the durable detail route behind an
                explicit action in the inspector." It is where the far-side
                object lives, which is the one thing no row here can carry.
              */}
              <Button onClick={() => onNavigate(`/datastores/${datastore.id}`)}>
                Open Datastore
              </Button>
              {/*
                By id, never by the name beside it. `getAppWorkspace` resolves
                either — `or(eq(apps.name, …), eq(apps.id, …))` — so a name
                works right up until two Apps share one, and this installation
                allows that: the Apps list carries an id per row precisely
                because two same-named Apps are two Apps. Navigating by name
                would open whichever of them the database answered with.
              */}
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
              onDetach={onDetach}
              onDestroy={onDestroy}
            />
          </>
        )}
      />
    </Page>
  );
}
