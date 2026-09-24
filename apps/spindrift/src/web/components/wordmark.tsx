import { WORDMARK } from '../brand.ts';
import { cn } from '../ui/utils.ts';

/**
 * The product's mark at the rail or hero setting. The rail's glitch plays only
 * on hover, so a mark in view all session never twitches on its own. The
 * underscore is decoration, hidden from screen readers.
 */
export function Wordmark({
  setting,
  className,
}: {
  readonly setting: 'rail' | 'hero';
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        setting === 'rail'
          ? // DM Mono is imported at 400 and 500 only; a heavier weight would be
            // synthesized as a smeared faux bold.
            'font-mono text-[15px] font-medium tracking-tight group-hover:motion-safe:animate-wink'
          : 'font-display text-[clamp(40px,6vw,64px)] font-black uppercase leading-none tracking-display motion-safe:animate-slip',
        className,
      )}
    >
      {WORDMARK}
      <span aria-hidden="true" className="text-brand">
        _
      </span>
    </span>
  );
}
