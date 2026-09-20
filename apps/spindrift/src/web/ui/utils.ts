/**
 * `cn` — the class merger every component in `ui/` composes through.
 *
 * Two jobs in one call, and they are different jobs. `clsx` flattens the
 * conditional forms a component wants to write (`{ hidden: !open }`, a nested
 * array, a `false` that should vanish). `tailwind-merge` then resolves the
 * conflicts that flattening exposes: a variant that sets `px-3` and a caller
 * that passes `px-6` both survive `clsx`, and only the last one should reach
 * the DOM.
 *
 * The consequence worth naming is that **a caller's `className` always wins**,
 * because it is merged last. That is what makes every component here
 * overridable at its call site without growing a prop for each thing somebody
 * might want to move.
 *
 * `extendTailwindMerge` rather than the bare export: plain `tailwind-merge`
 * has never heard of `styles.css`'s own `text-micro`/`-caption`/`-body`/`-ui`/
 * `-title`/`-display`/`-verdict` scale, so it classes each one as an unknown
 * font-size utility and drops it the moment a real colour utility (`text-
 * rail-foreground`, `text-rail-muted`, …) follows it in the same call — which
 * every rail row, group label and `Kbd` does. Naming the scale here is what
 * lets a size and a colour coexist the way `px-3`/`px-6` already do.
 */
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['micro', 'caption', 'body', 'ui', 'title', 'display', 'verdict'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Normalise a URL for an `href` — only prepend `https://` when the value
 * doesn't already carry a scheme. Backends (Firebase Hosting, Cloud Run)
 * and `displayUrl()` all return absolute URLs, so prepending
 * unconditionally would produce `https://https://…`.
 */
export function normaliseUrl(raw: string): string {
  if (!raw) return '';
  // Already has a proper scheme — return as-is.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  // Common typo: `https//…` instead of `https://…`. Fix it.
  const fixed = raw.replace(/^(https?):?\/\//i, '$1://');
  if (fixed !== raw) return fixed;
  return `https://${raw}`;
}
