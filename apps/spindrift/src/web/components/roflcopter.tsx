/**
 * kthx's mascot, carried over from the landing (`packages/kthx/landing.html`'s
 * `#copter`) rather than redrawn — the two things the owner named as staying
 * when the rest of that page's colouring did not.
 *
 * The art and the rotor are ported whole; the sky is not. The landing keeps
 * one instance that idles behind its own hero and restarts on a deploy; this
 * console gives the two jobs their own instances, because they answer to
 * different things — a screen being open, and an event this tab saw — and one
 * element cannot be both a loop and a one-shot at once. Three shapes, one
 * component:
 *
 * - the default (ambient) — a loop behind `views/auth/gate.tsx` and
 *   `views/auth/onboarding.tsx`, the two screens nobody has signed in on yet.
 * - `parked` — the same art, still, never ticking: the Apps list's empty
 *   state, beside the words rather than behind them.
 * - `flyover` — one instance, mounted once in `components/shell.tsx`, on
 *   screen only for the length of a pass. Silent until {@link flyover} is
 *   called, which is the landing's own "flies over on each deploy" — reached
 *   from wherever a Deploy this tab is watching is seen landing on `LIVE`
 *   (`views/apps/deploy-detail.tsx`).
 *
 * The rotor's scroll and the tail's turn are a 70ms text interval in every
 * shape that ticks at all — never CSS — the same split the landing's own
 * comment draws ("the sweep across the sky is CSS"). Only the sky crossing is
 * CSS, as `styles.css`'s `copter-drift`/`copter-pass` keyframes.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../ui/utils.ts';

/** One tick of the rotor tape, the width every frame is held to. */
export const ROTOR_WIDTH = 23;

/**
 * The rotor's tape. `ROFL` three times out of five turns and `LOL` once, the
 * landing's own ratio (`const ROT` in its script) — the trailing `:` is what
 * keeps the seam between one lap and the next a separator rather than a
 * `ROFLROFL` run-together.
 */
const ROTOR_TAPE = 'ROFL:ROFL:LOL:ROFL:ROFL:';

/**
 * The tail rotor's two frames, each three cells wide. Four blades around one
 * hub, so half a turn swaps the upright cross (`L`, `LoL`, `L`) for the
 * diagonal one (`L L`, `o`, `L L`) and every cell stays the width the art
 * around it was drawn for.
 */
const TAIL_FRAMES: readonly (readonly [string, string, string])[] = [
  [' L ', 'LoL', ' L '],
  ['L L', ' o ', 'L L'],
];

export interface RotorFrame {
  /** Always {@link ROTOR_WIDTH} characters, whatever `tick` was handed. */
  readonly rotor: string;
  /** Always three characters each. */
  readonly tail: readonly [string, string, string];
}

/**
 * What the rotor and the tail read at one tick, as a pure function of the
 * tick count — no timer, no DOM, nothing the landing's own `rk` needed a
 * running interval to answer.
 *
 * `tick` is taken modulo the tape's length first, so a caller does not have
 * to reason about the tape's length to stay in range, and a negative tick
 * (there is no caller that produces one today) still resolves rather than
 * indexing off the front of the string.
 */
export function rotorFrame(tick: number): RotorFrame {
  const wrapped =
    ((tick % ROTOR_TAPE.length) + ROTOR_TAPE.length) % ROTOR_TAPE.length;
  const rotor = (
    ROTOR_TAPE.slice(wrapped) + ROTOR_TAPE.slice(0, wrapped)
  ).slice(0, ROTOR_WIDTH);
  // `wrapped` is kept in range by the modulo above, so the index below
  // always lands on one of the two frames.
  const tail = TAIL_FRAMES[(wrapped >> 1) % TAIL_FRAMES.length]!;
  return { rotor, tail };
}

/** The event {@link flyover} raises, and the one `Roflcopter` in flyover mode listens for. */
const FLYOVER_EVENT = 'kthx:roflcopter-flyover';

/**
 * The live reduced-motion query, or `null` where there is none to ask —
 * `test/harness/dom.ts`'s shim is deliberately just enough DOM for
 * `react-dom/client` to mount into, and `matchMedia` is not part of that
 * subset. `null` reads as motion allowed, the same default a real browser
 * with no such preference set would answer.
 */
function reducedMotionQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
}

/**
 * The landing's "flies over on each deploy", reached from wherever a Deploy
 * is watched land on `LIVE` (`views/apps/deploy-detail.tsx`'s `DeployScreen`).
 *
 * A `window` event rather than a prop or a store: the one `Roflcopter` that
 * answers this is mounted once, in the shell, nowhere near the screen that
 * knows a deploy just landed — the same distance a toast crosses through
 * `ui/toast.tsx`'s `notify()`, and the same reason this is a function rather
 * than a context nobody between the two would otherwise thread.
 *
 * A no-op outside a browser: this is called from a `useEffect`-driven
 * callback in every caller today, but a stray server-side call is a mistake
 * to survive rather than a crash to cause.
 */
export function flyover(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FLYOVER_EVENT));
}

/** The rotor tape, rendered where a caller is showing the art at all. */
function Art({
  frame,
  className,
  onAnimationEnd,
}: {
  readonly frame: RotorFrame;
  readonly className?: string;
  readonly onAnimationEnd?: () => void;
}) {
  return (
    <pre
      aria-hidden="true"
      onAnimationEnd={onAnimationEnd}
      // `leading-[1.15]` last: every caller's own classes carry a font size
      // (`text-[10px]`/`text-[9px]`), and `tailwind-merge` treats a later
      // font-size utility as conflicting with an earlier line-height one, so
      // merged first it never reaches the DOM and the art falls back to the
      // body's own 1.5 — stretched about 30% tall, with the fuselage
      // diagonals and the tail rotor's cross no longer meeting. Merged last,
      // both survive.
      className={cn(
        'pointer-events-none select-none font-mono',
        className,
        'leading-[1.15]',
      )}
    >
      <span className="text-brand">{frame.rotor}</span>
      {'\n         ___^___ _\n'}
      <span>{frame.tail[0]}</span>
      {'   __/      [] \\\n'}
      <span>{frame.tail[1]}</span>
      {'===__           \\\n'}
      <span>{frame.tail[2]}</span>
      {'     \\___ ___ ___]\n'}
      {'             I   I\n'}
      {'         ----------/'}
    </pre>
  );
}

/**
 * Ticks the rotor while `active`, and stops without leaving a timer behind
 * the moment it is not.
 *
 * Idle under the same two conditions the landing's own interval checks —
 * `document.hidden`, so a backgrounded tab is not spending a timer on art
 * nobody can see, and reduced motion, so the mark is still rather than
 * ticking invisibly fast underneath a frozen sky. Both are read inside the
 * tick rather than used to decide whether to start it, because either can
 * become true or false while the interval is already running.
 */
function useRotor(active: boolean): RotorFrame {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const reduced = reducedMotionQuery();
    const id = setInterval(() => {
      if (document.hidden || reduced?.matches) return;
      setTick((current) => current + 1);
    }, 70);
    return () => clearInterval(id);
  }, [active]);

  return rotorFrame(tick);
}

export function Roflcopter({
  flyover: flies = false,
  parked = false,
  className,
}: {
  /**
   * This instance answers {@link flyover} instead of drawing anything on its
   * own — mount exactly one, in the shell. Every other prop is ignored: a
   * flyover is never a loop and never on screen until the event it exists
   * to answer.
   */
  readonly flyover?: boolean;
  /**
   * The Apps list's empty-state companion: the art, held on its very first
   * frame, ticking nothing. A screen with nothing on it yet is not a screen
   * that should visibly be doing something beside the words explaining that.
   */
  readonly parked?: boolean;
  readonly className?: string;
}): ReactNode {
  const [passing, setPassing] = useState(false);

  useEffect(() => {
    if (!flies) return;
    // Reduced motion answers this exactly once, at the moment the event
    // arrives, rather than gating the render below: an observation site
    // calling `flyover()` does not know or care whether this tab wants
    // motion, and asking it to check first would be the fly-over's own
    // contract leaking into every place that raises it.
    const reduced = reducedMotionQuery();
    const onFlyover = () => {
      if (!reduced?.matches) setPassing(true);
    };
    window.addEventListener(FLYOVER_EVENT, onFlyover);
    return () => window.removeEventListener(FLYOVER_EVENT, onFlyover);
  }, [flies]);

  const frame = useRotor(parked ? false : flies ? passing : true);

  if (flies) {
    if (!passing) return null;
    return (
      <div
        aria-hidden="true"
        // `components/shell.tsx` mounts this inside its `sticky` header
        // rather than beside it, which is what keeps the pass in the
        // viewport at any scroll offset instead of scrolling away with the
        // column beneath it — `top-full` is the header's own bottom edge, so
        // the art starts exactly where the header ends whether or not the
        // page has scrolled. No `z-index` of its own: `sticky` is a
        // positioned value, so the header already carries one stacking
        // context above everything in `<main>`, and every descendant of it
        // — this pass included — paints with it. `h-24` clears the seven-row
        // art's own height (`top-1` plus seven `leading-[1.15]` lines at
        // `text-[10px]`) with room to spare, so the skids at its foot are
        // never clipped the way a box sized to the art's old, leading-less
        // height would. `overflow-hidden` and `contain-strict` are the
        // landing's own answer to a `vw`-wide sweep that would otherwise push
        // the page into a horizontal scrollbar it never had.
        className="pointer-events-none absolute inset-x-0 top-full h-24 overflow-hidden contain-strict"
      >
        <Art
          frame={frame}
          onAnimationEnd={() => setPassing(false)}
          className="absolute top-1 text-[10px] opacity-70 motion-safe:animate-copter-pass"
        />
      </div>
    );
  }

  if (parked) {
    return (
      <Art frame={frame} className={cn('text-[9px] opacity-70', className)} />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden contain-strict"
    >
      <Art
        frame={frame}
        className={cn(
          'absolute bottom-[58vh] left-0 text-[clamp(8px,1.4vw,12px)] opacity-45',
          'motion-safe:animate-copter-drift motion-reduce:translate-x-[64vw]',
          className,
        )}
      />
    </div>
  );
}
