import { cad, cadCents, compact } from '~/fixtures/derive';

/*
 * One sign convention.
 *
 * The reader speaks in magnitudes: a figure that sits under or beside a word
 * naming its direction (spent, in, out, kept) is shown positive, with
 * `magnitude`. Everywhere else, in ledger rows, deltas, nets and every figure
 * in the inspector, an amount is signed from the household's side, with
 * `signedMoney`: + came in, − went out. Balances and net worth use `money`,
 * which marks only a negative.
 */

const MINUS = '−';

export function money(n: number, cents = true) {
  const s = (cents ? cadCents : cad).format(Math.abs(n));
  return n < 0 && !roundsToZero(n, cents) ? `${MINUS}${s}` : s;
}

export function signedMoney(n: number, cents = true) {
  const s = (cents ? cadCents : cad).format(Math.abs(n));
  if (roundsToZero(n, cents)) return s;
  return n < 0 ? `${MINUS}${s}` : `+${s}`;
}

export function magnitude(n: number, cents = true) {
  return (cents ? cadCents : cad).format(Math.abs(n));
}

export function kmoney(n: number) {
  const s = `$${compact.format(Math.abs(n))}`;
  return n < 0 ? `${MINUS}${s}` : s;
}

export function pct(n: number, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function roundsToZero(n: number, cents: boolean) {
  return Math.abs(n) < (cents ? 0.005 : 0.5);
}
