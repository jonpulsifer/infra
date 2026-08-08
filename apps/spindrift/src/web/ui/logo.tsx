/**
 * Logo — a platform's own mark, where the UI names that platform.
 *
 * Decorative by construction: every call site already says in words what the
 * mark is for ("Authorize the GitHub App", the adapter badge beside a Target),
 * so the image is hidden from assistive technology rather than repeating the
 * label a screen reader just read.
 *
 * The marks themselves live in `../client/logos/`, next to the client entry, so
 * the bundler reaches them and emits them content-hashed. See that directory's
 * `index.ts` for why they cannot live anywhere else.
 */
import type { ComponentProps } from 'react';
import { type LogoName, logos } from '../client/logos/index.ts';
import { cn } from './utils.ts';

/**
 * Marks drawn as a single near-black shape, which is invisible on a dark
 * surface. Inverting is right for exactly these — it would wreck a coloured
 * mark — so this is a fact about the two files, not a style choice.
 *
 * How much to invert is `--logo-invert`, read as a custom property rather than
 * through a `dark` variant. That variant keyed on `[data-theme="dark"]`, and
 * `theme.ts` *removes* that attribute for the `system` choice — deliberately,
 * because the absence of the attribute is what lets the OS preference win. So
 * the mark was un-inverted, on a dark page, for every reader who left the theme
 * to their machine: the GitHub logo beside "Authorize the GitHub App" was
 * near-black on near-black. A custom property flips with the resolved
 * `color-scheme` instead of with an attribute that may not be there.
 */
const MONO = new Set<LogoName>(['github', 'vercel']);

export function Logo({
  name,
  className,
  ...props
}: Omit<ComponentProps<'img'>, 'src' | 'alt'> & { name: LogoName }) {
  return (
    /* The rule below wants `next/image`, from a framework this client does not
       use. `src` is a content-hashed asset the bundler emitted, which
       `bundle.ts` already serves under a one-year immutable cache. */
    // biome-ignore lint/performance/noImgElement: no framework image component here
    <img
      src={logos[name]}
      alt=""
      aria-hidden="true"
      style={
        MONO.has(name) ? { filter: 'invert(var(--logo-invert))' } : undefined
      }
      className={cn('size-5 shrink-0 object-contain', className)}
      {...props}
    />
  );
}
