/**
 * Deleting an App in two calls: a review that writes nothing, then the
 * confirmed delete. Both go by id, because App names are not unique. After the
 * delete, the dialog stays open only to name what outlived it.
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

export interface AppIdentity {
  readonly id: string;
  readonly name: string;
}

export type AppDeletion =
  | { readonly kind: 'idle' }
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
  /** Deleted, with something left to remove by hand. */
  | {
      readonly kind: 'aftermath';
      /** So `dismiss` can report the App by id. */
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
  /** Writes nothing. */
  review(app: AppIdentity): void;
  /** A no-op outside `confirming`. */
  confirm(): void;
  /** Back out, or acknowledge the aftermath. */
  dismiss(): void;
}

/**
 * `onDeleted` fires once per delete, after any aftermath is dismissed. It gets
 * the id, since a list that dropped rows by name would drop every namesake.
 */
export function useAppDeletion(
  onDeleted: (app: AppIdentity) => void,
): AppDeletionControls {
  const [state, setState] = useState<AppDeletion>({ kind: 'idle' });

  // A ref keeps the callbacks below stable when the parent passes a new closure.
  const deleted = useRef(onDeleted);
  deleted.current = onDeleted;

  const review = useCallback(({ id, name }: AppIdentity) => {
    setState({ kind: 'reviewing', id, name });
    // `deleteApp` accepts an id in its `name` field.
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
      // The App is already gone, so dismissing the aftermath still reports it.
      if (current.kind === 'aftermath')
        deleted.current({ id: current.id, name: current.name });
      return { kind: 'idle' };
    });
  }, []);

  return { state, review, confirm, dismiss };
}

/** Takes the id as well as the name, since two rows can share a name. */
export function DeleteAppButton({
  appId,
  name,
  deletion,
  label = false,
}: {
  appId: string;
  name: string;
  deletion: AppDeletionControls;
  /** Show the word beside the icon. */
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
        // The list row around this button navigates on click.
        event.stopPropagation();
        deletion.review({ id: appId, name });
      }}
    >
      <Trash2 aria-hidden="true" />
      {label ? 'Delete' : null}
    </Button>
  );
}

/** A native `<dialog>`, which contains focus and handles Escape. */
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
        // Escape mid-delete would close the panel before the result arrives.
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
      {/* A static hosting site id is global, so tearing the site down spends it
          for good. */}
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
