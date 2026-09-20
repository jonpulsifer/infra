// Per-station identity colour, used for the panel dot, its sparkline and its
// temperature delta. The hue follows the station, never its rank, so a warmer
// reading never repaints a panel.
//
// Three hues, checked for colour-blind separation against the #0b0f15 ground
// (amber against green is the weakest pair and sits in the floor band, which is
// only legal alongside another cue - every panel is headed by its station name,
// so colour is never carrying identity alone). A fourth station and beyond gets
// the neutral: cycling would give two stations the same hue, which is worse
// than none.
export const STATION_ACCENTS = ['#2A93CC', '#CC7E2F', '#4FA45F'] as const;

export const NEUTRAL_ACCENT = '#8496AB';

export function stationAccent(index: number): string {
  return STATION_ACCENTS[index] ?? NEUTRAL_ACCENT;
}
