// The hue follows the station, never its rank. The three are checked for
// colour-blind separation on #0b0f15; a fourth station gets NEUTRAL_ACCENT.
export const STATION_ACCENTS = ['#2A93CC', '#CC7E2F', '#4FA45F'] as const;

export const NEUTRAL_ACCENT = '#8496AB';

export function stationAccent(index: number): string {
  return STATION_ACCENTS[index] ?? NEUTRAL_ACCENT;
}
