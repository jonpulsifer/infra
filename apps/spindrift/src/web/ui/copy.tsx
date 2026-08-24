/**
 * The values whose whole purpose is to be pasted somewhere else.
 *
 * A digest exists to be handed to `crane`, a commit to `git show`, a config
 * version to a support conversation. The app rendered all of them as truncated
 * monospace text with no way to get the untruncated value out — one
 * `navigator.clipboard` call existed in the entire tree — so the operator's
 * options were to select carefully around an ellipsis or to go find the value in
 * a terminal, which is the exact work this screen was supposed to save.
 *
 * `Ref` is the pairing that matters: it shortens by *kind*, because the useful
 * prefix of a digest is not the useful prefix of a URL, and it always copies the
 * whole thing rather than what is on screen. Truncation is a display decision
 * and must never become a data decision.
 *
 * `copyValue` is separate from the button on purpose. The clipboard is a browser
 * capability that is absent in an insecure context and refusable by the reader,
 * so the failure is ordinary rather than exceptional, and it is the one part of
 * this file worth testing without a DOM.
 *
 * Not here: a toast on copy. `notify()` for something that happened inside the
 * button that was just pressed would be the loudest possible way to report the
 * least surprising outcome in the app.
 */
import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from './utils.ts';

/** True when the value reached the clipboard. */
export async function copyValue(value: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    // Denied permission, an insecure origin, or a browser that has no
    // clipboard. None of those is an error the reader can act on, and all of
    // them leave the value on screen to select by hand.
    return false;
  }
}

/** How long the confirmation stands before the button is a button again. */
const CONFIRM_MS = 1_400;

export function CopyButton({
  value,
  label,
  className,
}: {
  readonly value: string;
  /** What is being copied, for the control's accessible name. */
  readonly label?: string;
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    void copyValue(value).then(setCopied);
  }, [value]);

  const name = label ? `Copy ${label}` : 'Copy';

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${name} — copied` : name}
      title={name}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-sm',
        'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

export type RefKind = 'digest' | 'commit' | 'url' | 'id';

/**
 * How much of each kind of reference is enough to recognise it.
 *
 * A digest keeps its algorithm prefix — `sha256:` is the half of it that says
 * what the rest of it is — and then the twelve hex characters `crane` and every
 * registry UI use. A commit is seven, which is git's own answer. An id is eight,
 * enough to tell two rows apart in a ledger. A URL keeps its host and drops the
 * scheme, because `https://` is the same on every row and the host is the fact.
 */
function shorten(value: string, kind: RefKind): string {
  if (kind === 'commit') return value.slice(0, 7);
  if (kind === 'id') return value.slice(0, 8);
  if (kind === 'url')
    return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const [algorithm, hex] = value.split(':');
  return hex ? `${algorithm}:${hex.slice(0, 12)}` : value.slice(0, 12);
}

export function Ref({
  value,
  kind,
  headline,
  className,
}: {
  readonly value: string;
  readonly kind: RefKind;
  /**
   * Words to put beside the hash — a commit's headline. The hash stays the
   * value that is copied and sorted; this is only what makes it readable.
   */
  readonly headline?: string | null;
  readonly className?: string;
}) {
  if (!value) return null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {/* The full value is the title, so a hover answers what the ellipsis ate
          even where the clipboard is unavailable. */}
      <span className="truncate font-mono text-body" title={value}>
        {shorten(value, kind)}
      </span>
      <CopyButton value={value} label={kind} />
      {headline ? (
        <span className="truncate text-body text-subtle" title={headline}>
          {headline}
        </span>
      ) : null}
    </span>
  );
}
