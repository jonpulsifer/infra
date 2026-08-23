import { SQL } from 'bun';

export type Entry = {
  at: string;
  route: string;
  network: string;
  payer: string;
  amount: string;
  asset: string;
  tx: string;
};

export type Leader = { payer: string; total: string; count: number };

/** Sum atomic-unit amounts per payer with BigInt; top `n` by total. */
export function leaderboard(entries: Entry[], n = 10): Leader[] {
  const totals = new Map<string, { total: bigint; count: number }>();
  for (const e of entries) {
    const t = totals.get(e.payer) ?? { total: 0n, count: 0 };
    t.total += BigInt(e.amount);
    t.count += 1;
    totals.set(e.payer, t);
  }
  return [...totals]
    .sort((a, b) =>
      a[1].total < b[1].total ? 1 : a[1].total > b[1].total ? -1 : 0,
    )
    .slice(0, n)
    .map(([payer, t]) => ({
      payer,
      total: t.total.toString(),
      count: t.count,
    }));
}

export function openLedger(databaseUrl?: string) {
  if (!databaseUrl) {
    // ponytail: in-memory ledger, Postgres when DATABASE_URL is set
    const rows: Entry[] = [];
    return {
      async add(e: Entry) {
        rows.push(e);
        if (rows.length > 1000) rows.shift();
      },
      async recent(n: number): Promise<Entry[]> {
        return rows.slice(-n).reverse();
      },
      async leaderboard(n: number): Promise<Leader[]> {
        return leaderboard(rows, n);
      },
    };
  }
  const sql = new SQL(databaseUrl);
  // Re-created on failure: a memoized rejection would wedge the ledger for
  // the process lifetime after one connection blip.
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= table().catch((err) => {
      ready = null;
      throw err;
    }));
  const table = () => sql`CREATE TABLE IF NOT EXISTS ledger (
    id bigserial primary key,
    at timestamptz not null default now(),
    route text not null,
    network text not null,
    payer text not null,
    amount text not null,
    asset text not null,
    tx text not null
  )`;
  const iso = (r: Entry) => ({ ...r, at: new Date(r.at).toISOString() });
  return {
    async add(e: Entry) {
      await ensure();
      await sql`INSERT INTO ledger ${sql(e, 'at', 'route', 'network', 'payer', 'amount', 'asset', 'tx')}`;
    },
    async recent(n: number): Promise<Entry[]> {
      await ensure();
      const rows: Entry[] =
        await sql`SELECT at, route, network, payer, amount, asset, tx FROM ledger ORDER BY id DESC LIMIT ${n}`;
      return rows.map(iso);
    },
    async leaderboard(n: number): Promise<Leader[]> {
      await ensure();
      // ponytail: full scan + JS fold, GROUP BY when rows outgrow it
      const rows: Entry[] = await sql`SELECT payer, amount FROM ledger`;
      return leaderboard(rows, n);
    },
  };
}

export type Ledger = ReturnType<typeof openLedger>;
