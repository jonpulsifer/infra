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
 * **No create or attach here.** Both need an App-and-Target picker this
 * screen has no home for — `createDatastore` binds to a placed Target and
 * `attachDatastore` binds to an App, and a global ledger has neither selected.
 * They stay exactly where §11 put them, on the workspace of the App they
 * would attach to. What lives here are the two acts that take only a
 * Datastore id: Detach and Destroy, one at a time and never both, because the
 * row already says which one core would accept — `destroyDatastore` refuses
 * while attached. That is stricter than the workspace's section, which offers
 * Destroy on every row and lets the refusal come back as a sentence; here the
 * reader has no App open to detach from first, so a button whose only outcome
 * is that refusal is worth less than the one act that works.
 *
 * Not a `SupplyChainTabs` member. §2's chain is Source + Build = Artifact;
 * a Datastore is never an input to that chain or an output of it, so tabbing
 * it in beside Builds and Sources would draw a fourth stage that does not
 * exist.
 */
import { Database } from 'lucide-react';
import { useState } from 'react';
import {
  DefinitionGrid,
  LedgerExplorer,
} from '../../components/object-explorer.tsx';
import type { DatastoreListItem } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import type { Column } from '../../ui/data-table.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
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
    header: 'Target',
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

export function DatastoreLedger({
  datastores,
  onNavigate,
  onDetach,
  onDestroy,
}: {
  readonly datastores: readonly DatastoreListItem[];
  readonly onNavigate: (path: string) => void;
  readonly onDetach: DatastoreAct;
  readonly onDestroy: DatastoreAct;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Attached resources"
        title="Datastores"
        description="Every Postgres and Valkey Datastore this installation holds, attached or not. Creating one and attaching it to an App both stay on that App's workspace — this is where the rest of the lifecycle is read."
      />
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
            Creating one and attaching it to an App is done from that App's
            workspace.
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
                { label: 'Target', value: datastore.target },
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
