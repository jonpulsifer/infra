/**
 * Values meant to be pasted elsewhere. `Ref` shortens each kind for display and
 * always copies the full value.
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
    // Denied, an insecure origin, or no clipboard. The value stays selectable.
    return false;
  }
}

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

/** Twelve digest characters as registry UIs show, and seven as git does. */
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
  href,
  className,
}: {
  readonly value: string;
  readonly kind: RefKind;
  /** Shown beside the hash, such as a commit's headline. Never copied. */
  readonly headline?: string | null;
  readonly href?: string;
  readonly className?: string;
}) {
  if (!value) return null;
  const short = shorten(value, kind);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={value}
          className="truncate font-mono text-body underline decoration-border underline-offset-2 transition-colors duration-100 ease-out hover:decoration-current hover:text-accent-foreground"
        >
          {short}
        </a>
      ) : (
        <span className="truncate font-mono text-body" title={value}>
          {short}
        </span>
      )}
      <CopyButton value={value} label={kind} />
      {headline ? (
        <span className="truncate text-body text-subtle" title={headline}>
          {headline}
        </span>
      ) : null}
    </span>
  );
}
