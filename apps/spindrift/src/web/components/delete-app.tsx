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
 * - **Stranded workloads.** Nothing is torn down (§13) — after the delete, this
 *   list is the only record that those workloads are there, so the flow does not
 *   close on its own when there is one. The operator dismisses it.
 * - **Retained secrets.** §10's store items are reaped with the App; the ones a
 *   store refused are named, because nothing will reach them again.
 *
 * The confirm call goes by `appId`, never by the name that was typed: the review
 * already resolved which App this is, and re-resolving a name that a second App
 * has since taken would delete the wrong one.
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

export type AppDeletion =
  | { readonly kind: 'idle' }
  /** The review call is in flight. */
  | { readonly kind: 'reviewing'; readonly name: string }
  | {
      readonly kind: 'confirming';
      readonly name: string;
      readonly effects: DeleteAppEffects;
    }
  | {
      readonly kind: 'deleting';
      readonly name: string;
      readonly effects: DeleteAppEffects;
    }
  /** Done, and something outlived it that somebody has to go and deal with. */
  | {
      readonly kind: 'aftermath';
      readonly name: string;
      readonly stranded: readonly StrandedWorkload[];
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
  review(name: string): void;
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
 */
export function useAppDeletion(
  onDeleted: (name: string) => void,
): AppDeletionControls {
  const [state, setState] = useState<AppDeletion>({ kind: 'idle' });

  // Held in a ref so `confirm` does not have to be rebuilt — and every pending
  // request re-checked — every time a parent re-renders with a new closure.
  const deleted = useRef(onDeleted);
  deleted.current = onDeleted;

  const review = useCallback((name: string) => {
    setState({ kind: 'reviewing', name });
    command('deleteApp', { name, confirm: false })
      .then((result) => {
        if (!result.ok) {
          setState({ kind: 'failed', name, message: result.failure.message });
          return;
        }
        setState({ kind: 'confirming', name, effects: result.value });
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
      const { name, effects } = current;

      command('deleteApp', { name: effects.appId, confirm: true })
        .then((result) => {
          if (!result.ok) {
            setState({ kind: 'failed', name, message: result.failure.message });
            return;
          }
          const value = result.value;
          const retained = value.deleted ? value.retainedSecrets : [];
          if (value.stranded.length === 0 && retained.length === 0) {
            setState({ kind: 'idle' });
            deleted.current(name);
            return;
          }
          setState({
            kind: 'aftermath',
            name,
            stranded: value.stranded,
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

      return { kind: 'deleting', name, effects };
    });
  }, []);

  const dismiss = useCallback(() => {
    setState((current) => {
      // The App is already gone by then; the caller has to hear about it even
      // though what closed the panel was a dismissal rather than a success.
      if (current.kind === 'aftermath') deleted.current(current.name);
      return { kind: 'idle' };
    });
  }, []);

  return { state, review, confirm, dismiss };
}

/** The trash affordance, so no screen writes its own. */
export function DeleteAppButton({
  name,
  deletion,
  label = false,
}: {
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
        deletion.review(name);
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
      <p className="animate-pulse text-sm text-muted-foreground">
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
        {state.stranded.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              These workloads are still running. Nothing manages them now, so
              removing them is a manual job on the Target.
            </p>
            <Stranded stranded={state.stranded} />
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
              ? 'One workload is live and will keep running'
              : `${effects.stranded.length} workloads are live and will keep running`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deleting the App does not stop them. You will have to remove them on
            the Target by hand.
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
  return (
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
