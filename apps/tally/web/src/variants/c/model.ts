import {
  cad,
  cadCents,
  categoryById,
  compact,
  isIncome,
  isSpend,
  monthKey,
  topLevel,
} from '~/fixtures/derive';
import type { Finding, Ledger, Transaction } from '~/fixtures/types';

export type Question = 'worth' | 'spend' | 'payees' | 'saving' | 'wrong';
export type Tab = 'home' | 'ledger' | 'import' | 'accounts';

export function shiftMonth(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function monthEnd(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function utc(ym: string) {
  const [y, m, d] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d || 1));
}

export function monthLong(ym: string, withYear = false) {
  return utc(ym).toLocaleDateString('en-CA', {
    month: 'long',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

export function monthShort(ym: string) {
  return utc(ym).toLocaleDateString('en-CA', {
    month: 'short',
    timeZone: 'UTC',
  });
}

export function dayLabel(iso: string, withYear = false) {
  return utc(iso).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

export function money(n: number) {
  return cad.format(Math.round(n)).replace('-', '−');
}

export function moneyCents(n: number) {
  return cadCents.format(n).replace('-', '−');
}

export function moneyShort(n: number) {
  const s = compact.format(Math.abs(n));
  return `${n < 0 ? '−' : ''}$${s}`;
}

export function moneySigned(n: number) {
  return `${n > 0 ? '+' : ''}${money(n)}`;
}

export function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

export function currentMonth(ledger: Ledger) {
  return monthKey(ledger.asOf);
}

export function isPartialMonth(ledger: Ledger, ym: string) {
  return currentMonth(ledger) === ym && ledger.asOf < monthEnd(ym);
}

export function periodFrom(ym: string, span: number) {
  return `${shiftMonth(ym, -(span - 1))}-01`;
}

export function spendByMonth(ledger: Ledger) {
  const out = new Map<string, number>();
  for (const t of ledger.transactions) {
    if (!isSpend(t, ledger)) continue;
    const m = monthKey(t.date);
    out.set(m, (out.get(m) ?? 0) - t.amount);
  }
  return out;
}

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function usualSpend(byMonth: Map<string, number>, ym: string) {
  const prior: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const v = byMonth.get(shiftMonth(ym, -i));
    if (v !== undefined) prior.push(v);
  }
  return median(prior);
}

export function spendAnswer(
  ledger: Ledger,
  ym: string,
  byMonth: Map<string, number>,
) {
  const spent = byMonth.get(ym) ?? 0;
  const usual = usualSpend(byMonth, ym);
  const diff = spent - usual;
  const partial = isPartialMonth(ledger, ym);
  const name = monthLong(ym, ym.slice(0, 4) !== ledger.asOf.slice(0, 4));
  const when = partial ? `${name} so far` : name;
  if (!usual)
    return { line: `You spent ${money(spent)} in ${when}`, spent, usual, diff };
  const cmp =
    Math.abs(diff) < usual * 0.03
      ? 'about usual'
      : `${money(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than usual`;
  return {
    line: `You spent ${money(spent)} in ${when}, ${cmp}`,
    spent,
    usual,
    diff,
  };
}

export function initials(name: string) {
  const words = name
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

export function ruleMatchFor(descriptor: string) {
  return descriptor.split(/\s+/).slice(0, 2).join(' ');
}

export function matchesRule(t: Transaction, match: string) {
  return t.descriptor.toLowerCase().includes(match.toLowerCase());
}

export function categoryName(ledger: Ledger, id: string) {
  return categoryById(ledger).get(id)?.name ?? id;
}

export function groupOf(ledger: Ledger, id: string) {
  return topLevel(ledger, id).id;
}

export function leafCategories(ledger: Ledger) {
  const tops = ledger.categories.filter(
    (c) => c.parentId === null && c.flow !== 'transfer',
  );
  return tops.map((top) => ({
    top,
    leaves: ledger.categories.filter((c) => c.parentId === top.id),
  }));
}

export function txById(ledger: Ledger) {
  return new Map(ledger.transactions.map((t) => [t.id, t]));
}

export function accountName(ledger: Ledger, id: string | null) {
  if (!id) return 'Unmatched';
  return ledger.accounts.find((a) => a.id === id)?.name ?? id;
}

export function savingFor(ledger: Ledger, ym: string) {
  let income = 0;
  let spend = 0;
  for (const t of ledger.transactions) {
    if (monthKey(t.date) !== ym) continue;
    if (isIncome(t, ledger)) income += t.amount;
    else if (isSpend(t, ledger)) spend -= t.amount;
  }
  return { income, spend, net: income - spend };
}

export function findingTitle(f: Finding) {
  switch (f.kind) {
    case 'duplicate':
      return 'Possible duplicate';
    case 'missing-period':
      return 'A gap in the statements';
    case 'transfer':
      return 'Looks like a transfer';
    case 'low-confidence':
      return 'Not sure what this is';
  }
}

export const OUTCOME_TEXT: Record<string, string> = {
  merged: 'Merged into one',
  kept: 'Kept both',
  linked: 'Linked as a transfer',
  reviewed: 'Marked reviewed',
  accepted: 'Category accepted',
  skipped: 'Left as is',
};

export function niceTicks(min: number, max: number, count = 4) {
  if (max === min) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
