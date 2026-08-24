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
export type PayerStats = {
  payer: string;
  total: string;
  count: number;
  first: string | null;
  last: string | null;
};
export type Stats = { count: number; total: string; payers: number };
export type Pass = { payer: string; expires_at: string };

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

const sum = (entries: { amount: string }[]) =>
  entries.reduce((t, e) => t + BigInt(e.amount), 0n).toString();
const tipName = (route: string) =>
  route.slice('/tip/'.length).split('/')[0] as string;

export function openLedger(databaseUrl?: string) {
  if (!databaseUrl) {
    // ponytail: in-memory ledger, Postgres when DATABASE_URL is set
    const rows: Entry[] = [];
    const kv = new Map<string, string>();
    const passes = new Map<string, Pass>();
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
      async payer(payer: string): Promise<PayerStats> {
        const mine = rows.filter((e) => e.payer === payer);
        return {
          payer,
          total: sum(mine),
          count: mine.length,
          first: mine[0]?.at ?? null,
          last: mine.at(-1)?.at ?? null,
        };
      },
      async stats(): Promise<Stats> {
        return {
          count: rows.length,
          total: sum(rows),
          payers: new Set(rows.map((e) => e.payer)).size,
        };
      },
      async tips(n: number): Promise<string[]> {
        return rows
          .filter((e) => e.route.startsWith('/tip/'))
          .slice(-n)
          .reverse()
          .map((e) => tipName(e.route));
      },
      async kvGet(payer: string, key: string) {
        return kv.get(`${payer}:${key}`);
      },
      async kvSet(payer: string, key: string, value: string) {
        kv.set(`${payer}:${key}`, value);
      },
      async passAdd(hash: string, payer: string, expiresAt: string) {
        passes.set(hash, { payer, expires_at: expiresAt });
      },
      async passGet(hash: string) {
        return passes.get(hash);
      },
    };
  }
  const sql = new SQL(databaseUrl);
  // Re-created on failure: a memoized rejection would wedge the ledger for
  // the process lifetime after one connection blip.
  let ready: Promise<unknown> | null = null;
  const ensure = () =>
    (ready ??= tables().catch((err) => {
      ready = null;
      throw err;
    }));
  const tables = async () => {
    await sql`CREATE TABLE IF NOT EXISTS ledger (
      id bigserial primary key,
      at timestamptz not null default now(),
      route text not null,
      network text not null,
      payer text not null,
      amount text not null,
      asset text not null,
      tx text not null
    )`;
    await sql`CREATE TABLE IF NOT EXISTS kv (
      payer text not null,
      key text not null,
      value text not null,
      at timestamptz not null default now(),
      primary key (payer, key)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS pass (
      token_hash text primary key,
      payer text not null,
      expires_at timestamptz not null
    )`;
  };
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
    async payer(payer: string): Promise<PayerStats> {
      await ensure();
      const rows: { amount: string; at: string }[] =
        await sql`SELECT amount, at FROM ledger WHERE payer = ${payer} ORDER BY id`;
      const at = (r?: { at: string }) =>
        r ? new Date(r.at).toISOString() : null;
      return {
        payer,
        total: sum(rows),
        count: rows.length,
        first: at(rows[0]),
        last: at(rows.at(-1)),
      };
    },
    async stats(): Promise<Stats> {
      await ensure();
      const [r] = await sql`SELECT count(*)::int AS count,
        coalesce(sum(amount::numeric), 0)::text AS total,
        count(distinct payer)::int AS payers FROM ledger`;
      return r as Stats;
    },
    async tips(n: number): Promise<string[]> {
      await ensure();
      const rows: { route: string }[] =
        await sql`SELECT route FROM ledger WHERE route LIKE '/tip/%' ORDER BY id DESC LIMIT ${n}`;
      return rows.map((r) => tipName(r.route));
    },
    async kvGet(payer: string, key: string) {
      await ensure();
      const [r] =
        await sql`SELECT value FROM kv WHERE payer = ${payer} AND key = ${key}`;
      return (r as { value: string } | undefined)?.value;
    },
    async kvSet(payer: string, key: string, value: string) {
      await ensure();
      await sql`INSERT INTO kv (payer, key, value) VALUES (${payer}, ${key}, ${value})
        ON CONFLICT (payer, key) DO UPDATE SET value = excluded.value, at = now()`;
    },
    async passAdd(hash: string, payer: string, expiresAt: string) {
      await ensure();
      await sql`INSERT INTO pass (token_hash, payer, expires_at) VALUES (${hash}, ${payer}, ${expiresAt})`;
    },
    async passGet(hash: string) {
      await ensure();
      const [r] =
        await sql`SELECT payer, expires_at FROM pass WHERE token_hash = ${hash}`;
      const p = r as { payer: string; expires_at: string } | undefined;
      return p && { ...p, expires_at: new Date(p.expires_at).toISOString() };
    },
  };
}

export type Ledger = ReturnType<typeof openLedger>;
