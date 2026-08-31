/**
 * Colour, and the only file in the CLI that knows an escape code.
 *
 * The rules that decide whether anything is emitted at all are checked on every
 * call rather than once at import, because a test — and a pipe — can change the
 * answer inside one process:
 *
 * - `NO_COLOR` set to anything, or `TERM=dumb`, or stdout is not a TTY → plain
 *   text, byte for byte. Piping `kthx ls` into `grep` must not have to strip
 *   anything.
 * - `COLORTERM=truecolor|24bit` → 24-bit `38;2;r;g;b`. Anything else falls back
 *   to the 6×6×6 cube of the 256-colour palette, which every `xterm-256color`
 *   has had for twenty years.
 *
 * Errors are never painted: they go to stderr, which nothing here touches.
 */

/**
 * The ramp the banner and the URLs are drawn from: the landing page's hot pink
 * at one end and its acid green at the other, with the hues between them.
 *
 * Every stop is saturated and sits near 0.2–0.4 relative luminance, so the
 * gradient holds contrast against a black terminal *and* a white one. The
 * landing page's own `#b6ff3b` is 0.63 and would vanish on paper-white.
 */
const RAMP: readonly (readonly [number, number, number])[] = [
  [255, 45, 155],
  [168, 85, 247],
  [33, 150, 243],
  [0, 184, 160],
  [91, 168, 0],
];

const RESET = '\x1b[0m';

/** 0 no colour, 1 the 256-colour cube, 2 truecolor. */
export function level(): 0 | 1 | 2 {
  const { NO_COLOR, TERM, COLORTERM } = process.env;
  if (NO_COLOR !== undefined && NO_COLOR !== '') return 0;
  if (TERM === 'dumb') return 0;
  if (process.stdout.isTTY !== true) return 0;
  return COLORTERM === 'truecolor' || COLORTERM === '24bit' ? 2 : 1;
}

/** The ramp sampled at `t` in 0..1, linearly between the two nearest stops. */
function stop(t: number): readonly [number, number, number] {
  const scaled = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
  const index = Math.min(Math.floor(scaled), RAMP.length - 2);
  const fraction = scaled - index;
  const from = RAMP[index] as readonly [number, number, number];
  const to = RAMP[index + 1] as readonly [number, number, number];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * fraction);
  return [mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])];
}

/** The 6×6×6 cube index nearest a colour, for terminals without truecolor. */
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

/** `text` in one colour from the ramp, `at` in 0..1. */
export function tint(text: string, at: number): string {
  const depth = level();
  return depth === 0 ? text : `${sequence(stop(at), depth)}${text}${RESET}`;
}

/**
 * `text` with the ramp spread across it, one stop per character.
 *
 * Equal-length lines get the same colour per column, which is what makes the
 * banner's gradient run down the block letters rather than restart each row.
 */
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

/** A URL, underlined so it is the thing the eye lands on and the mouse hits. */
export const link = (url: string) =>
  level() === 0 ? url : `\x1b[4m${tint(url, 0.55)}\x1b[24m`;

/** Secondary text: the same words, half the attention. */
export const faint = (text: string) =>
  level() === 0 ? text : `\x1b[2m${text}\x1b[22m`;

/**
 * `kthx`, drawn on a five-row grid one column per pixel and doubled on the way
 * out, because a terminal cell is about twice as tall as it is wide and an
 * undoubled letter comes out as a thin smear.
 */
const GRID = [
  '█   █ █████ █   █ █   █',
  '█  █    █   █   █  █ █ ',
  '███     █   █████   █  ',
  '█  █    █   █   █  █ █ ',
  '█   █   █   █   █ █   █',
];

/** The banner and one line under it. 48 columns, so an 80-column terminal fits. */
export function banner(subtitle: string): string {
  const rows = GRID.map(
    (row) => `  ${rainbow(row.replace(/./g, (pixel) => pixel + pixel))}`,
  );
  return `\n${rows.join('\n')}\n\n  ${subtitle}\n`;
}
