/**
 * What just happened, said once, where the reader is looking.
 *
 * The app had exactly one answer for the result of an act: ten copies of a red
 * div pasted into `app.tsx`, one per screen, each rendering a refusal and none
 * rendering a success. So "Rolled back to build 1187" — the sentence an
 * operator most wants after the scariest button in the product — had nowhere to
 * appear, and a failure appeared in a box the reader may have scrolled past.
 *
 * A module-level listener store, subscribed with `useSyncExternalStore`, copied
 * from `connection-status.ts` on purpose: `notify()` is then callable from an
 * event handler, a promise chain, or a `catch` block in a module that renders
 * nothing, without any of them holding a context or a ref. No provider, no
 * dependency, no portal — `ToastHost` is mounted once in the shell and is the
 * only reader of this store.
 *
 * What it refuses to be is a queue with priorities, a place to put a form, or a
 * substitute for stating a refusal beside the control that caused it. A toast
 * is for the act that already left the screen it was pressed on. A field that
 * is invalid is `Field`'s `issue`, not this.
 *
 * Dismissal lives in the host, not the store: a timer started at `notify()`
 * would keep running in a server render and in a test that never mounts
 * anything, and would fire against a listener set nobody is in.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Button } from './button.tsx';
import { cn } from './utils.ts';

export type Tone = 'success' | 'warning' | 'destructive' | 'accent';

export interface Toast {
  readonly id: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onSelect: () => void };
}

/** How long a toast stands before the host retires it. */
const DWELL_MS = 6_000;

/**
 * A refusal is read, not glanced at, and the reader may have been in another
 * tab when it landed.
 */
const DWELL_DESTRUCTIVE_MS = 12_000;

let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();

/**
 * The server has no toasts, and this constant is the same object every call so
 * `useSyncExternalStore` does not see a new snapshot on every render.
 */
const NONE: readonly Toast[] = [];

let sequence = 0;

export function notify(toast: Omit<Toast, 'id'>): void {
  sequence += 1;
  toasts = [...toasts, { ...toast, id: `toast:${sequence}` }];
  for (const listener of listeners) listener();
}

export function dismissToast(id: string): void {
  const remaining = toasts.filter((toast) => toast.id !== id);
  if (remaining.length === toasts.length) return;
  toasts = remaining;
  for (const listener of listeners) listener();
}

export function activeToasts(): readonly Toast[] {
  return toasts;
}

export function onToastChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const TONE = {
  success: 'border-l-success text-success',
  warning: 'border-l-warning text-warning',
  destructive: 'border-l-destructive text-destructive',
  accent: 'border-l-primary text-accent-foreground',
} as const satisfies Record<Tone, string>;

/**
 * Mounted once, in the shell.
 *
 * `role="status"`/`aria-live="polite"` rather than `alert`: even a destructive
 * result here is the outcome of something the reader just did, so interrupting
 * their current sentence to read it is the wrong trade. The region exists in
 * the DOM whether or not it holds anything, because a live region inserted at
 * the same moment as its content is not reliably announced.
 */
export function ToastHost() {
  const items = useSyncExternalStore(onToastChange, activeToasts, () => NONE);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Recent results"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      {items.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useCallback(() => dismissToast(toast.id), [toast.id]);

  useEffect(() => {
    const timer = setTimeout(
      dismiss,
      toast.tone === 'destructive' ? DWELL_DESTRUCTIVE_MS : DWELL_MS,
    );
    return () => clearTimeout(timer);
  }, [dismiss, toast.tone]);

  return (
    <div
      className={cn(
        'pointer-events-auto w-full max-w-sm rounded-sm border border-border border-l-2 bg-card px-3.5 py-3',
        'shadow-panel',
        TONE[toast.tone],
      )}
    >
      <p className="text-body font-semibold">{toast.title}</p>
      {toast.detail ? (
        <p className="mt-1 text-body text-muted-foreground">{toast.detail}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {toast.action ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              toast.action?.onSelect();
              dismiss();
            }}
          >
            {toast.action.label}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
