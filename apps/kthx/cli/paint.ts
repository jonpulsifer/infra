/**
 * Terminal colour. This is the only CLI file that writes escape codes, and it
 * never paints stderr.
 */

// Every stop sits near 0.2–0.4 relative luminance, so it reads on black and on
// white. The landing page's `#b6ff3b` is 0.63 and vanishes on white.
const RAMP: readonly (readonly [number, number, number])[] = [
  [255, 45, 155],
  [168, 85, 247],
  [33, 150, 243],
  [0, 184, 160],
  [91, 168, 0],
];

const RESET = '\x1b[0m';

/**
 * 0 no colour, 1 the 256-colour cube, 2 truecolor. Read on every call, because
 * a pipe or a test can change the answer within one process.
 */
export function level(): 0 | 1 | 2 {
  const { NO_COLOR, TERM, COLORTERM } = process.env;
  if (NO_COLOR !== undefined && NO_COLOR !== '') return 0;
  if (TERM === 'dumb') return 0;
  if (process.stdout.isTTY !== true) return 0;
  return COLORTERM === 'truecolor' || COLORTERM === '24bit' ? 2 : 1;
}

function stop(t: number): readonly [number, number, number] {
  const scaled = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  const index = Math.min(Math.floor(scaled), RAMP.length - 2);
  const fraction = scaled - index;
  const from = RAMP[index] as readonly [number, number, number];
  const to = RAMP[index + 1] as readonly [number, number, number];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * fraction);
  return [mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])];
}

/** The nearest index in the 256-colour palette's 6×6×6 cube. */
const cube = (r: number, g: number, b: number) =>
  16 +
  36 * Math.round((r / 255) * 5) +
  6 * Math.round((g / 255) * 5) +
  Math.round((b / 255) * 5);

const sequence = (
  [r, g, b]: readonly [number, number, number],
  depth: 1 | 2,
): string =>
  depth === 2 ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${cube(r, g, b)}m`;

/** `at` is a position on the ramp, 0..1. */
export function tint(text: string, at: number): string {
  const depth = level();
  return depth === 0 ? text : `${sequence(stop(at), depth)}${text}${RESET}`;
}

// Equal-length lines get the same colour per column, so the banner's gradient
// runs down the letters.
export function rainbow(text: string): string {
  const depth = level();
  if (depth === 0) return text;
  const characters = [...text];
  const last = characters.length - 1;
  let out = '';
  let current = '';
  for (const [index, character] of characters.entries()) {
    const next = sequence(stop(last === 0 ? 0 : index / last), depth);
    if (next !== current) {
      out += next;
      current = next;
    }
    out += character;
  }
  return `${out}${RESET}`;
}

export const link = (url: string) =>
  level() === 0 ? url : `\x1b[4m${tint(url, 0.55)}\x1b[24m`;

export const faint = (text: string) =>
  level() === 0 ? text : `\x1b[2m${text}\x1b[22m`;

// Each pixel is printed twice, because a terminal cell is about twice as tall
// as it is wide.
const GRID = [
  '█   █ █████ █   █ █   █',
  '█  █    █   █   █  █ █ ',
  '███     █   █████   █  ',
  '█  █    █   █   █  █ █ ',
  '█   █   █   █   █ █   █',
];

/** 48 columns wide, so it fits an 80-column terminal. */
export function banner(subtitle: string): string {
  const rows = GRID.map(
    (row) => `  ${rainbow(row.replace(/./g, (pixel) => pixel + pixel))}`,
  );
  return `\n${rows.join('\n')}\n\n  ${subtitle}\n`;
}
