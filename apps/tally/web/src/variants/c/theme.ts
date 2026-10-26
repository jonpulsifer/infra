export type Palette = {
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  accent: string;
  series: string[];
  neutralNode: string;
  neutralLink: string;
  positive: string;
  negative: string;
  critical: string;
  good: string;
  linkAlpha: number;
};

const LIGHT: Palette = {
  surface: '#fafaf9',
  ink: '#1c1917',
  ink2: '#57534e',
  muted: '#78716c',
  grid: '#e7e5e4',
  axis: '#d6d3d1',
  accent: '#d97706',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  neutralNode: '#57534e',
  neutralLink: '#a8a29e',
  positive: '#2a78d6',
  negative: '#e34948',
  critical: '#d03b3b',
  good: '#0ca30c',
  linkAlpha: 0.3,
};

const DARK: Palette = {
  surface: '#1c1917',
  ink: '#f5f5f4',
  ink2: '#d6d3d1',
  muted: '#a8a29e',
  grid: '#292524',
  axis: '#44403c',
  accent: '#fbbf24',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
  neutralNode: '#a8a29e',
  neutralLink: '#78716c',
  positive: '#3987e5',
  negative: '#e66767',
  critical: '#d03b3b',
  good: '#0ca30c',
  linkAlpha: 0.5,
};

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

export const GROUP_ORDER = ['housing', 'food', 'transport', 'living', 'fun'];

export function groupColor(id: string, pal: Palette) {
  const i = GROUP_ORDER.indexOf(id);
  if (i >= 0) return pal.series[i];
  if (id === 'saved') return pal.series[5];
  return pal.neutralLink;
}

export const WORTH_PARTS = [
  { key: 'house', name: 'House' },
  { key: 'investments', name: 'Investments' },
  { key: 'cash', name: 'Cash and cards' },
  { key: 'mortgage', name: 'Mortgage' },
] as const;

function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function inkOn(hex: string) {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance('#1c1917') + 0.05);
  return onDark > onWhite ? '#1c1917' : '#ffffff';
}
