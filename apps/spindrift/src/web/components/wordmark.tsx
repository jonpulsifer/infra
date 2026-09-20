import { WORDMARK } from '../brand.ts';

/**
 * The product's own mark. `ui/logo.tsx` draws everyone else's.
 *
 * It owns the word and nothing about how it sits: the rail sets it small beside
 * a glyph, the signed-out screens set it large and alone, so the classes are
 * the caller's.
 */
export function Wordmark({ className }: { readonly className?: string }) {
  return <span className={className}>{WORDMARK}</span>;
}
