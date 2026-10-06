/**
 * Results of an act, announced once. A module-level store lets `notify()` run
 * from any handler or promise; `ToastHost` in the shell is its only reader.
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

const DWELL_MS = 6_000;

/** A refusal is read in full, and the reader may have been in another tab. */
const DWELL_DESTRUCTIVE_MS = 12_000;

let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();

/** One object for every call, so the server snapshot stays stable. */
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
 * Polite, since the reader caused every result. The region always exists: one
 * inserted together with its content is not reliably announced.
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

  // The timer lives here, so a server render or a test never starts one.
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
        'motion-safe:animate-rise',
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
