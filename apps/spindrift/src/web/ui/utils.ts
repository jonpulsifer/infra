/**
 * `cn` merges classes through `clsx` and `tailwind-merge`, so a caller's
 * `className` wins over a variant's.
 */
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Plain tailwind-merge does not know the custom `text-*` sizes, and drops one
// when a `text-*` colour follows it in the same call.
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

/** Prepends `https://` only when the value has no scheme. */
export function normaliseUrl(raw: string): string {
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  // Repairs a missing colon, as in `https//`.
  const fixed = raw.replace(/^(https?):?\/\//i, '$1://');
  if (fixed !== raw) return fixed;
  return `https://${raw}`;
}
