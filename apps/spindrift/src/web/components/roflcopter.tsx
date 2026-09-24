/**
 * The mascot, ported from `packages/kthx/landing.html`: an ambient loop, a still
 * parked frame, or one flyover pass per {@link flyover} call. The rotor and tail
 * tick on a 70ms interval; only the crossing is CSS.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../ui/utils.ts';

/** Characters in every rotor frame. */
export const ROTOR_WIDTH = 23;

// The trailing `:` separates one lap of the tape from the next.
const ROTOR_TAPE = 'ROFL:ROFL:LOL:ROFL:ROFL:';

// Half a turn of a four-bladed rotor, each row three cells wide to fit the art.
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

/** `tick` wraps, so any integer, negative included, picks a frame. */
export function rotorFrame(tick: number): RotorFrame {
  const wrapped =
    ((tick % ROTOR_TAPE.length) + ROTOR_TAPE.length) % ROTOR_TAPE.length;
  const rotor = (
    ROTOR_TAPE.slice(wrapped) + ROTOR_TAPE.slice(0, wrapped)
  ).slice(0, ROTOR_WIDTH);
  // The modulo keeps `wrapped` in range, so the index always hits a frame.
  const tail = TAIL_FRAMES[(wrapped >> 1) % TAIL_FRAMES.length]!;
  return { rotor, tail };
}

const FLYOVER_EVENT = 'kthx:roflcopter-flyover';

/** `null`, which allows motion, where there is no `matchMedia` (the test DOM). */
function reducedMotionQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
}

/**
 * A window event, because the one listening `Roflcopter` sits in the shell, far
 * from the screen that sees a deploy go live. A no-op outside a browser.
 */
export function flyover(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FLYOVER_EVENT));
}

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
      // Line height goes last: tailwind-merge drops it when a caller's font size
      // follows, and the art stretches until its lines no longer meet.
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
 * Idle while the tab is hidden or reduced motion is on, checked on each tick
 * because either can change while the interval runs.
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
  /** Draws only on a {@link flyover} call. Mount one, in the shell. */
  readonly flyover?: boolean;
  /** Held on the first frame, ticking nothing. */
  readonly parked?: boolean;
  readonly className?: string;
}): ReactNode {
  const [passing, setPassing] = useState(false);

  useEffect(() => {
    if (!flies) return;
    // Checked when the event arrives, so callers of `flyover()` never check it.
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
        // Mounted inside the shell's sticky header, whose bottom edge it hangs
        // from at any scroll. The clip keeps the sweep from widening the page.
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
