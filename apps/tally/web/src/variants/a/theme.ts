import { cad, cadCents, compact } from '~/fixtures/derive';

export type Palette = {
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  axis: string;
  accent: string;
  income: string;
  spend: string;
  good: string;
  warn: string;
  bad: string;
  cat: Record<string, string>;
};

export const CAT_ORDER = [
  'housing',
  'food',
  'transport',
  'living',
  'fun',
  'uncategorized',
] as const;

const LIGHT: Palette = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  ink3: '#77756f',
  grid: '#ebeae5',
  axis: '#c3c2b7',
  accent: '#2a78d6',
  income: '#008300',
  spend: '#a8a69e',
  good: '#006300',
  warn: '#b77c00',
  bad: '#d03b3b',
  cat: {
    housing: '#2a78d6',
    food: '#eb6834',
    transport: '#1baf7a',
    living: '#eda100',
    fun: '#e87ba4',
    uncategorized: '#a8a69e',
  },
};

const DARK: Palette = {
  surface: '#141413',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  ink3: '#8f8d86',
  grid: '#262624',
  axis: '#3a3a37',
  accent: '#3987e5',
  income: '#0ca30c',
  spend: '#5f5e59',
  good: '#0ca30c',
  warn: '#fab219',
  bad: '#e66767',
  cat: {
    housing: '#3987e5',
    food: '#d95926',
    transport: '#199e70',
    living: '#c98500',
    fun: '#d55181',
    uncategorized: '#5f5e59',
  },
};

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT;
}

export const tw = {
  surface: 'bg-[#fcfcfb] dark:bg-[#141413]',
  rail: 'bg-[#f4f4f1] dark:bg-[#0e0e0d]',
  ink: 'text-[#0b0b0b] dark:text-[#f0efec]',
  ink2: 'text-[#52514e] dark:text-[#c3c2b7]',
  ink3: 'text-[#77756f] dark:text-[#8f8d86]',
  rule: 'border-[#e4e3dd] dark:border-[#2a2a27]',
  ruleBg: 'bg-[#e4e3dd] dark:bg-[#2a2a27]',
  hover: 'hover:bg-[#f1f0ec] dark:hover:bg-[#1d1d1b]',
  wash: 'bg-[#f1f0ec] dark:bg-[#1d1d1b]',
  selected: 'bg-[#eaf2fc] dark:bg-[#18263a]',
  good: 'text-[#006300] dark:text-[#0ca30c]',
  warn: 'text-[#8a5d00] dark:text-[#fab219]',
  bad: 'text-[#b52f2f] dark:text-[#e66767]',
  accent: 'text-[#2a78d6] dark:text-[#5a9cec]',
  num: 'font-mono tabular-nums',
  label: 'text-[10px] font-medium uppercase tracking-[0.08em]',
  input:
    'h-7 rounded-[3px] border border-[#dcdbd4] bg-[#fcfcfb] px-2 text-[12px] outline-none focus:border-[#2a78d6] dark:border-[#33332f] dark:bg-[#141413] dark:focus:border-[#3987e5]',
  btn: 'inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-[#dcdbd4] px-2 text-[11px] font-medium hover:bg-[#f1f0ec] disabled:opacity-40 dark:border-[#33332f] dark:hover:bg-[#1d1d1b]',
  btnPrimary:
    'inline-flex h-6 items-center gap-1.5 rounded-[3px] bg-[#0b0b0b] px-2 text-[11px] font-medium text-[#fcfcfb] hover:bg-[#2b2b29] disabled:opacity-40 dark:bg-[#f0efec] dark:text-[#141413] dark:hover:bg-[#d8d7d2]',
};

const MINUS = '−';

export function money(n: number, cents = true) {
  const s = (cents ? cadCents : cad).format(Math.abs(n));
  return n < 0 ? `${MINUS}${s}` : s;
}

export function signedMoney(n: number, cents = true) {
  const s = (cents ? cadCents : cad).format(Math.abs(n));
  if (Math.abs(n) < 0.005) return s;
  return n < 0 ? `${MINUS}${s}` : `+${s}`;
}

export function kmoney(n: number) {
  const s = `$${compact.format(Math.abs(n))}`;
  return n < 0 ? `${MINUS}${s}` : s;
}

export function pct(n: number, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function shortDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}
