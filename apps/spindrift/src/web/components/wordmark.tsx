import { WORDMARK } from '../brand.ts';
import { cn } from '../ui/utils.ts';

/**
 * The product's own mark, in the two settings this console draws it at.
 * `ui/logo.tsx` draws everyone else's.
 *
 * Both are kthx's own — the landing's `.big` (`packages/kthx/landing.html`)
 * and its console mock's `Wordmark` (`app-shell.tsx`) — kept as one component
 * rather than two call sites free to drift apart as the brand's mark changes.
 * `rail` is the compact mono setting the header draws it at; `hero` is the
 * landing's display setting, for the two screens nobody has signed in on yet
 * (`views/auth/gate.tsx`, `views/auth/onboarding.tsx`).
 *
 * **The glitch, at two speeds.** The landing's own `.big` slips out of
 * register and back roughly once every seven seconds, unprompted — right for
 * a hero nobody is doing anything else on. The rail sits in front of a reader
 * mid-task for the whole session, and a mark that glitches on its own clock
 * there reads as a rendering fault the tenth time it happens, not a wink —
 * so it slips only on hover instead, the same animation at a tenth-second
 * length: something you get by reaching for the mark, not something the mark
 * does at you. `components/shell.tsx` puts `group` on the button this span
 * sits in for exactly that hover to reach it.
 *
 * The underscore is decoration, not a letter of the name, so it is the one
 * part of this markup marked `aria-hidden` — the plain text node beside it is
 * what a screen reader is left to name the element from, and that text node
 * is {@link WORDMARK} alone.
 *
 * `className` is the caller's, same as before: which colour, which margin,
 * whether it truncates is a fact about where it sits, not about the mark.
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
          ? // `font-medium` (500), not `font-semibold` (600): DM Mono is only
            // imported at 400 and 500, and a browser asked for a weight
            // above the heaviest cut it has synthesizes a faux bold rather
            // than refusing — the brand's own mark, drawn smeared.
            'font-mono text-[15px] font-medium tracking-tight group-hover:motion-safe:animate-wink'
          : // Orbitron at its heaviest weight, upper-case and near the display
            // face's own tight tracking token — the landing's `.big`, minus
            // the letter-by-letter entrance Task 3 owns, plus the loop it
            // does have: `animate-slip`, unprompted, every seven seconds.
            'font-display text-[clamp(40px,6vw,64px)] font-black uppercase leading-none tracking-display motion-safe:animate-slip',
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
