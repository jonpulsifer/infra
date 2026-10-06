/**
 * A platform's own mark. Every call site names the platform in words, so the
 * image is hidden from assistive technology.
 */
import type { ComponentProps } from 'react';
import { type LogoName, logos } from '../client/logos/index.ts';
import { cn } from './utils.ts';

/**
 * Near-black marks, inverted by `--logo-invert` on dark surfaces. A custom
 * property also follows the `system` theme, which sets no `data-theme`.
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
