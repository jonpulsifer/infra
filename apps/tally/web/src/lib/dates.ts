const MONTHS_LONG =
  'January February March April May June July August September October November December'.split(
    ' ',
  );

export function mShort(ym: string) {
  return MONTHS_LONG[Number(ym.slice(5, 7)) - 1].slice(0, 3);
}

export function mLong(ym: string) {
  return `${mShort(ym)} ${ym.slice(0, 4)}`;
}

export function monthName(ym: string) {
  return MONTHS_LONG[Number(ym.slice(5, 7)) - 1];
}

export function longDate(iso: string) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_LONG[m - 1].slice(0, 3)} ${d}, ${y}`;
}

export function daysIn(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Shift an ISO date by whole months, clamping the day. */
export function shiftIso(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const day = Math.min(d || 1, daysIn(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
