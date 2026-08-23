/**
 * Deleting an App, in the two calls the command takes (§2).
 *
 * `deleteApp` reviews before it acts, so the screen does too: the first call
 * writes nothing and answers with what the delete would do, and this is where
 * that answer is read aloud. **The confirmation is the feature** — an App with
 * nothing deployed deletes with a glance at one sentence, and an App with a live
 * workload cannot be deleted without the operator having been shown the workload
 * that will keep running with nothing managing it.
 *
 * Two things are stated rather than hidden, both because the row that recorded
 * them is about to stop existing:
 *
 * - **Live workloads.** Confirming tears them down, so they are named first —
 *   this is the screen where an operator finds out that deleting the App stops
 *   the thing serving traffic. One on static hosting says so twice over, because
 *   the teardown spends the site id permanently and no amount of going back
 *   undoes it.
 * - **Retained secrets.** §10's store items are reaped with the App; the ones a
 *   store refused are named, because nothing will reach them again.
 *
 * The flow only stops on the way out when something outlived the delete — a
 * teardown the platform refused, or a store item it would not destroy. Those are
 * the manual jobs, and the operator dismisses the list rather than the list
 * closing itself.
 *
 * Both calls go by `appId`, never by the name on the button: `apps` has no
 * unique constraint on `name`, so a name is a label rather than an identifier.
 * The review refuses `INVALID_INPUT` on a name two Apps answer to — correctly,
 * because guessing which of two to delete is not recoverable — and a screen
 * that could only offer the name would dead-end there, never reaching the
 * confirmation that carries the id. The name is still carried alongside,
 * because every sentence in the dialog before the review lands is about the App
 * the operator pointed at, and a uuid is not what they pointed at.
 */
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DeleteAppEffects,
  StrandedWorkload,
} from '../../commands/apps/delete.ts';
import { command } from '../client.ts';
import { Button } from '../ui/button.tsx';
import { Eyebrow } from '../ui/card.tsx';

/** Which App this is, and what the operator calls it. */
export interface AppIdentity {
  /** What both `deleteApp` calls resolve on. */
  readonly id: string;
  /** What the dialog says while it is still talking about a pending act. */
  readonly name: string;
}

export type AppDeletion =
  | { readonly kind: 'idle' }
  /** The review call is in flight. */
  | { readonly kind: 'reviewing'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'confirming';
      readonly id: string;
      readonly name: string;
      readonly effects: DeleteAppEffects;
    }
  | {
      readonly kind: 'deleting';
      readonly id: string;
      readonly name: string;
      readonly effects: DeleteAppEffects;
    }
  /** Done, and something outlived it that somebody has to go and deal with. */
  | {
      readonly kind: 'aftermath';
      /** Carried so `dismiss` can report *which* App went, not just its label. */
      readonly id: string;
      readonly name: string;
      readonly retainedWorkloads: readonly string[];
      readonly retainedSecrets: readonly string[];
    }
  | {
      readonly kind: 'failed';
      readonly name: string;
      readonly message: string;
    };

export interface AppDeletionControls {
  readonly state: AppDeletion;
  /** Ask what deleting this App would do. Nothing is written. */
  review(app: AppIdentity): void;
  /** Do it. Only meaningful from `confirming`. */
  confirm(): void;
  /** Back out, or acknowledge the aftermath. */
  dismiss(): void;
}

/**
 * The flow, without the chrome.
 *
 * `onDeleted` fires once per completed delete, after the operator has seen any
 * aftermath — so a caller can navigate away or drop a row without racing the
 * one screen that still names what was stranded.
 *
 * It reports the whole {@link AppIdentity} rather than the name, for the reason
 * this module already gives about `deleteApp`'s own arguments: `apps` has no
 * unique constraint on `name`. A list that dropped its row by name would hide
 * every App sharing it, which is precisely the pair this flow exists to let an
 * operator take apart.
 */
export function useAppDeletion(
  onDeleted: (app: AppIdentity) => void,
): AppDeletionControls {
  const [state, setState] = useState<AppDeletion>({ kind: 'idle' });

  // Held in a ref so `confirm` does not have to be rebuilt — and every pending
  // request re-checked — every time a parent re-renders with a new closure.
  const deleted = useRef(onDeleted);
  deleted.current = onDeleted;

  const review = useCallback(({ id, name }: AppIdentity) => {
    setState({ kind: 'reviewing', id, name });
    // `deleteApp` takes the id in the field it names `name`, precisely so a
    // caller holding one does not have to go back through a name.
    command('deleteApp', { name: id, confirm: false })
      .then((result) => {
        if (!result.ok) {
          setState({ kind: 'failed', name, message: result.failure.message });
          return;
        }
        setState({ kind: 'confirming', id, name, effects: result.value });
      })
      .catch((error: unknown) => {
        setState({
          kind: 'failed',
          name,
          message:
            error instanceof Error
              ? error.message
              : 'Could not reach the server',
        });
      });
  }, []);

  const confirm = useCallback(() => {
    setState((current) => {
      if (current.kind !== 'confirming') return current;
      const { id, name, effects } = current;

      command('deleteApp', { name: effects.appId, confirm: true })
        .then((result) => {
          if (!result.ok) {
            setState({ kind: 'failed', name, message: result.failure.message });
            return;
          }
          const value = result.value;
          const retained = value.deleted ? value.retainedSecrets : [];
          const workloads = value.deleted ? value.retainedWorkloads : [];
          if (workloads.length === 0 && retained.length === 0) {
            setState({ kind: 'idle' });
            deleted.current({ id, name });
            return;
          }
          setState({
            kind: 'aftermath',
            id,
            name,
            retainedWorkloads: workloads,
            retainedSecrets: retained,
          });
        })
        .catch((error: unknown) => {
          setState({
            kind: 'failed',
            name,
            message:
              error instanceof Error
                ? error.message
                : 'Could not reach the server',
          });
        });

      return { kind: 'deleting', id, name, effects };
    });
  }, []);

  const dismiss = useCallback(() => {
    setState((current) => {
      // The App is already gone by then; the caller has to hear about it even
      // though what closed the panel was a dismissal rather than a success.
      if (current.kind === 'aftermath')
        deleted.current({ id: current.id, name: current.name });
      return { kind: 'idle' };
    });
  }, []);

  return { state, review, confirm, dismiss };
}

/**
 * The trash affordance, so no screen writes its own.
 *
 * It takes the id as well as the name because the name is what the operator
 * reads and the id is what the command acts on — a button offered per row has
 * to be able to say which row, and two rows can share a name.
 */
export function DeleteAppButton({
  appId,
  name,
  deletion,
  label = false,
}: {
  appId: string;
  name: string;
  deletion: AppDeletionControls;
  /** Show the word beside the icon — the workspace has room, a list row does not. */
  label?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size={label ? 'default' : 'icon'}
      aria-label={`Delete ${name}`}
      title={`Delete ${name}`}
      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      onClick={(event) => {
        // A list row is a link to the workspace; deleting is not navigating.
        event.stopPropagation();
        deletion.review({ id: appId, name });
      }}
    >
      <Trash2 aria-hidden="true" />
      {label ? 'Delete' : null}
    </Button>
  );
}

/**
 * The modal. A native `<dialog>` rather than a div: focus containment and
 * Escape are the two things a hand-rolled overlay reliably gets wrong, and a
 * destructive confirmation is the worst place to get them wrong.
 */
export function DeleteAppDialog({
  deletion,
}: {
  deletion: AppDeletionControls;
}) {
  const { state, confirm, dismiss } = deletion;
  const ref = useRef<HTMLDialogElement>(null);
  const open = state.kind !== 'idle';

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={
        'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border ' +
        'bg-card p-0 text-foreground backdrop:bg-black/50'
      }
      onCancel={(event) => {
        // Escape during the delete itself would close a panel over an act that
        // is still running, and the result would land on nothing.
        if (state.kind === 'deleting') event.preventDefault();
        else dismiss();
      }}
    >
      <div className="flex flex-col gap-4 p-5">
        <Body state={state} />
        <Actions state={state} onConfirm={confirm} onDismiss={dismiss} />
      </div>
    </dialog>
  );
}

function Body({ state }: { state: AppDeletion }) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'reviewing') {
    return (
      <p className="text-sm text-muted-foreground">
        Working out what deleting {state.name} would do...
      </p>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div>
        <Eyebrow>Delete failed</Eyebrow>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">
          {state.name} was not deleted
        </h2>
        <p className="mt-2 text-sm text-destructive">{state.message}</p>
      </div>
    );
  }

  if (state.kind === 'aftermath') {
    return (
      <div>
        <Eyebrow>Deleted</Eyebrow>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">
          {state.name} is gone, and this is not
        </h2>
        {state.retainedWorkloads.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              These could not be removed and are still on the Target. Nothing
              manages them now, so removing them is a manual job on the Target.
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {state.retainedWorkloads.map((workload) => (
                <li key={workload} className="font-mono text-xs text-subtle">
                  {workload}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {state.retainedSecrets.length > 0 ? (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              These config items are still in the store — nothing will read them
              again:
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {state.retainedSecrets.map((secret) => (
                <li key={secret} className="font-mono text-xs text-subtle">
                  {secret}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  const { effects } = state;
  return (
    <div>
      <Eyebrow>Delete App</Eyebrow>
      <h2 className="mt-1 text-lg font-semibold tracking-tight">
        Delete {effects.name}?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {summarize(effects)} This cannot be undone.
      </p>

      {effects.stranded.length > 0 ? (
        <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle aria-hidden="true" className="size-4" />
            {effects.stranded.length === 1
              ? 'One workload is live and will be torn down'
              : `${effects.stranded.length} workloads are live and will be torn down`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deleting the App stops them. Anything the Target refuses to tear
            down is named afterwards, to remove by hand.
          </p>
          <Stranded stranded={effects.stranded} />
        </div>
      ) : null}

      {effects.detachedDatastores.length > 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {effects.detachedDatastores.join(', ')}{' '}
          {effects.detachedDatastores.length === 1
            ? 'survives, detached'
            : 'survive, detached'}{' '}
          — a Datastore is not deleted with the App it was attached to.
        </p>
      ) : null}
    </div>
  );
}

function Stranded({ stranded }: { stranded: readonly StrandedWorkload[] }) {
  const spent = stranded.filter((workload) => workload.nameSpent);
  return (
    <>
      <ul className="mt-2 flex flex-col gap-1">
        {stranded.map((workload) => (
          <li
            key={workload.deployId}
            className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs"
          >
            <span className="font-semibold">{workload.component}</span>
            <span className="text-muted-foreground">on {workload.target}</span>
            {workload.url ? (
              <span className="text-subtle">{workload.url}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {/* The half of the teardown that cannot be undone by deploying again: a
          static hosting site id is global and permanent, so removing the site
          spends the address forever. */}
      {spent.length > 0 ? (
        <p className="mt-2 text-sm text-destructive">
          {spent.length === 1
            ? `${spent[0]?.component} is on static hosting, and its site id is spent permanently`
            : `${spent.map((workload) => workload.component).join(', ')} are on static hosting, and their site ids are spent permanently`}{' '}
          — tearing the site down does not give the name back, and nothing can
          ever be deployed under it again.
        </p>
      ) : null}
    </>
  );
}

/** What goes, in one sentence — counts rather than a list nobody reads. */
function summarize(effects: DeleteAppEffects): string {
  const parts: string[] = [];
  if (effects.components.length > 0) {
    parts.push(
      effects.components.length === 1
        ? `its Component ${effects.components[0]}`
        : `its ${effects.components.length} Components`,
    );
  }
  if (effects.builds > 0) {
    parts.push(
      `${effects.builds} ${effects.builds === 1 ? 'Build' : 'Builds'}`,
    );
  }
  if (effects.deploys > 0) {
    parts.push(
      `${effects.deploys} ${effects.deploys === 1 ? 'Deploy' : 'Deploys'}`,
    );
  }
  if (effects.configKeys.length > 0) {
    parts.push(
      `${effects.configKeys.length} config ${
        effects.configKeys.length === 1 ? 'key' : 'keys'
      }`,
    );
  }
  if (parts.length === 0) return 'Nothing else belongs to it.';
  const last = parts.pop() as string;
  const list = parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
  return `This removes ${list}.`;
}

function Actions({
  state,
  onConfirm,
  onDismiss,
}: {
  state: AppDeletion;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  if (state.kind === 'idle') return null;

  if (state.kind === 'reviewing') {
    return (
      <div className="flex justify-end">
        <Button variant="outline" onClick={onDismiss}>
          Cancel
        </Button>
      </div>
    );
  }

  if (state.kind === 'failed' || state.kind === 'aftermath') {
    return (
      <div className="flex justify-end">
        <Button onClick={onDismiss}>
          {state.kind === 'aftermath' ? 'Understood' : 'Close'}
        </Button>
      </div>
    );
  }

  const deleting = state.kind === 'deleting';
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" onClick={onDismiss} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
        {deleting ? 'Deleting...' : `Delete ${state.effects.name}`}
      </Button>
    </div>
  );
}
