// Deterministic synthetic ledger: a Halifax household, 2021-01 to 2026-10.
// Nothing here is real. Same seed, same ledger, every load.

import type {
  Account,
  BalanceAssertion,
  Category,
  Finding,
  HoldingSnapshot,
  ImportBatch,
  ImportPreview,
  Ledger,
  Rule,
  Transaction,
  Valuation,
} from './types';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = new Date(Date.UTC(2021, 0, 1));
const END = new Date(Date.UTC(2026, 9, 24));

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function monthsBetween(a: Date, b: Date) {
  const out: Date[] = [];
  const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  while (d <= b) {
    out.push(new Date(d));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export const ACCOUNTS: Account[] = [
  {
    id: 'rbc-chq',
    name: 'Chequing',
    institution: 'RBC',
    kind: 'chequing',
    since: '2021-01-01',
  },
  {
    id: 'rbc-sav',
    name: 'High Interest Savings',
    institution: 'RBC',
    kind: 'savings',
    since: '2021-01-01',
  },
  {
    id: 'amex',
    name: 'Cobalt',
    institution: 'Amex',
    kind: 'credit',
    since: '2021-01-01',
  },
  {
    id: 'td-visa',
    name: 'Cash Back Visa',
    institution: 'TD',
    kind: 'credit',
    since: '2021-01-01',
  },
  {
    id: 'mortgage',
    name: 'Mortgage',
    institution: 'RBC',
    kind: 'mortgage',
    since: '2022-06-15',
  },
  {
    id: 'house',
    name: 'House',
    institution: 'Manual',
    kind: 'asset',
    since: '2022-06-15',
  },
  {
    id: 'ws-tfsa',
    name: 'TFSA',
    institution: 'Wealthsimple',
    kind: 'investment',
    since: '2021-01-01',
  },
  {
    id: 'qt-rrsp',
    name: 'RRSP',
    institution: 'Questrade',
    kind: 'investment',
    since: '2021-01-01',
  },
  {
    id: 'scotia-old',
    name: 'Old Chequing',
    institution: 'Scotiabank',
    kind: 'chequing',
    since: '2021-01-01',
  },
];

export const CATEGORIES: Category[] = [
  { id: 'income', name: 'Income', parentId: null, flow: 'income' },
  { id: 'salary', name: 'Salary', parentId: 'income', flow: 'income' },
  {
    id: 'interest',
    name: 'Interest & dividends',
    parentId: 'income',
    flow: 'income',
  },
  { id: 'refunds', name: 'Refunds', parentId: 'income', flow: 'income' },
  { id: 'housing', name: 'Housing', parentId: null, flow: 'expense' },
  {
    id: 'mortgage-pay',
    name: 'Mortgage',
    parentId: 'housing',
    flow: 'expense',
  },
  { id: 'rent', name: 'Rent', parentId: 'housing', flow: 'expense' },
  { id: 'utilities', name: 'Utilities', parentId: 'housing', flow: 'expense' },
  { id: 'home', name: 'Home & repairs', parentId: 'housing', flow: 'expense' },
  {
    id: 'property-tax',
    name: 'Property tax',
    parentId: 'housing',
    flow: 'expense',
  },
  { id: 'food', name: 'Food', parentId: null, flow: 'expense' },
  { id: 'groceries', name: 'Groceries', parentId: 'food', flow: 'expense' },
  { id: 'restaurants', name: 'Restaurants', parentId: 'food', flow: 'expense' },
  { id: 'coffee', name: 'Coffee', parentId: 'food', flow: 'expense' },
  { id: 'transport', name: 'Transport', parentId: null, flow: 'expense' },
  { id: 'fuel', name: 'Fuel', parentId: 'transport', flow: 'expense' },
  {
    id: 'car',
    name: 'Car & insurance',
    parentId: 'transport',
    flow: 'expense',
  },
  {
    id: 'transit',
    name: 'Transit & taxis',
    parentId: 'transport',
    flow: 'expense',
  },
  { id: 'living', name: 'Living', parentId: null, flow: 'expense' },
  { id: 'shopping', name: 'Shopping', parentId: 'living', flow: 'expense' },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    parentId: 'living',
    flow: 'expense',
  },
  { id: 'health', name: 'Health', parentId: 'living', flow: 'expense' },
  { id: 'kids', name: 'Kids', parentId: 'living', flow: 'expense' },
  { id: 'pets', name: 'Pets', parentId: 'living', flow: 'expense' },
  { id: 'fun', name: 'Fun', parentId: null, flow: 'expense' },
  { id: 'travel', name: 'Travel', parentId: 'fun', flow: 'expense' },
  {
    id: 'entertainment',
    name: 'Entertainment',
    parentId: 'fun',
    flow: 'expense',
  },
  {
    id: 'hobbies',
    name: 'Hobbies & homelab',
    parentId: 'fun',
    flow: 'expense',
  },
  { id: 'gifts', name: 'Gifts & giving', parentId: 'fun', flow: 'expense' },
  { id: 'transfer', name: 'Transfer', parentId: null, flow: 'transfer' },
  {
    id: 'cc-payment',
    name: 'Credit card payment',
    parentId: 'transfer',
    flow: 'transfer',
  },
  {
    id: 'savings-xfer',
    name: 'To savings',
    parentId: 'transfer',
    flow: 'transfer',
  },
  {
    id: 'invest-xfer',
    name: 'To investments',
    parentId: 'transfer',
    flow: 'transfer',
  },
  {
    id: 'uncategorized',
    name: 'Uncategorized',
    parentId: null,
    flow: 'expense',
  },
];

type MerchantSpec = {
  descriptor: string;
  merchant: string;
  categoryId: string;
  account: string;
  /** Mean spend and spread. */
  mean: number;
  sd: number;
  /** Expected occurrences per month. */
  perMonth: number;
  from?: string;
  to?: string;
};

const MERCHANTS: MerchantSpec[] = [
  {
    descriptor: 'SOBEYS #0742 HALIFAX NS',
    merchant: 'Sobeys',
    categoryId: 'groceries',
    account: 'amex',
    mean: 112,
    sd: 40,
    perMonth: 5,
  },
  {
    descriptor: 'COSTCO WHOLESALE W1284',
    merchant: 'Costco',
    categoryId: 'groceries',
    account: 'amex',
    mean: 248,
    sd: 70,
    perMonth: 1.5,
  },
  {
    descriptor: 'ATLANTIC SUPERSTORE 304',
    merchant: 'Superstore',
    categoryId: 'groceries',
    account: 'td-visa',
    mean: 86,
    sd: 30,
    perMonth: 2,
  },
  {
    descriptor: 'SQ *WEIRD HARBOUR ESPRESSO',
    merchant: 'Weird Harbour',
    categoryId: 'coffee',
    account: 'amex',
    mean: 6.4,
    sd: 1.5,
    perMonth: 9,
  },
  {
    descriptor: 'TIM HORTONS #3341',
    merchant: 'Tim Hortons',
    categoryId: 'coffee',
    account: 'td-visa',
    mean: 4.1,
    sd: 1,
    perMonth: 6,
  },
  {
    descriptor: 'UBER EATS   HELP.UBER.COM',
    merchant: 'Uber Eats',
    categoryId: 'restaurants',
    account: 'amex',
    mean: 47,
    sd: 15,
    perMonth: 3,
  },
  {
    descriptor: 'THE BICYCLE THIEF HALIFAX',
    merchant: 'Bicycle Thief',
    categoryId: 'restaurants',
    account: 'amex',
    mean: 142,
    sd: 40,
    perMonth: 0.4,
  },
  {
    descriptor: 'SKIP*THE DISHES WINNIPEG',
    merchant: 'SkipTheDishes',
    categoryId: 'restaurants',
    account: 'td-visa',
    mean: 39,
    sd: 12,
    perMonth: 2,
  },
  {
    descriptor: 'IRVING 24 BEDFORD HWY',
    merchant: 'Irving',
    categoryId: 'fuel',
    account: 'td-visa',
    mean: 78,
    sd: 18,
    perMonth: 3,
  },
  {
    descriptor: 'NS POWER PREAUTH',
    merchant: 'Nova Scotia Power',
    categoryId: 'utilities',
    account: 'rbc-chq',
    mean: 186,
    sd: 60,
    perMonth: 1,
  },
  {
    descriptor: 'BELL ALIANT FIBREOP',
    merchant: 'Bell Aliant',
    categoryId: 'utilities',
    account: 'rbc-chq',
    mean: 119,
    sd: 2,
    perMonth: 1,
  },
  {
    descriptor: 'STARLINK INTERNET',
    merchant: 'Starlink',
    categoryId: 'utilities',
    account: 'amex',
    mean: 140,
    sd: 0,
    perMonth: 1,
    from: '2023-04-01',
  },
  {
    descriptor: 'HALIFAX WATER',
    merchant: 'Halifax Water',
    categoryId: 'utilities',
    account: 'rbc-chq',
    mean: 94,
    sd: 20,
    perMonth: 0.34,
    from: '2022-07-01',
  },
  {
    descriptor: 'HRM PROPERTY TAX',
    merchant: 'HRM',
    categoryId: 'property-tax',
    account: 'rbc-chq',
    mean: 2210,
    sd: 60,
    perMonth: 0.167,
    from: '2022-07-01',
  },
  {
    descriptor: 'KENT BUILDING SUPPLIES',
    merchant: 'Kent',
    categoryId: 'home',
    account: 'amex',
    mean: 96,
    sd: 80,
    perMonth: 1.2,
    from: '2022-06-15',
  },
  {
    descriptor: 'AMZN Mktp CA*2K9',
    merchant: 'Amazon',
    categoryId: 'shopping',
    account: 'amex',
    mean: 54,
    sd: 45,
    perMonth: 4,
  },
  {
    descriptor: 'NETFLIX.COM',
    merchant: 'Netflix',
    categoryId: 'subscriptions',
    account: 'amex',
    mean: 20.99,
    sd: 0,
    perMonth: 1,
  },
  {
    descriptor: 'SPOTIFY P2A1B3',
    merchant: 'Spotify',
    categoryId: 'subscriptions',
    account: 'amex',
    mean: 16.99,
    sd: 0,
    perMonth: 1,
  },
  {
    descriptor: 'APPLE.COM/BILL',
    merchant: 'Apple',
    categoryId: 'subscriptions',
    account: 'amex',
    mean: 12.99,
    sd: 6,
    perMonth: 1.3,
  },
  {
    descriptor: 'GOOGLE *CLOUD 7F2',
    merchant: 'Google Cloud',
    categoryId: 'hobbies',
    account: 'amex',
    mean: 61,
    sd: 25,
    perMonth: 1,
  },
  {
    descriptor: 'HETZNER ONLINE GMBH',
    merchant: 'Hetzner',
    categoryId: 'hobbies',
    account: 'amex',
    mean: 38,
    sd: 4,
    perMonth: 1,
  },
  {
    descriptor: 'NEWEGG CANADA',
    merchant: 'Newegg',
    categoryId: 'hobbies',
    account: 'amex',
    mean: 230,
    sd: 180,
    perMonth: 0.4,
  },
  {
    descriptor: 'SHOPPERS DRUG MART 0239',
    merchant: 'Shoppers',
    categoryId: 'health',
    account: 'td-visa',
    mean: 32,
    sd: 20,
    perMonth: 2,
  },
  {
    descriptor: 'PETSMART 2191',
    merchant: 'PetSmart',
    categoryId: 'pets',
    account: 'td-visa',
    mean: 68,
    sd: 25,
    perMonth: 1,
  },
  {
    descriptor: 'CINEPLEX 7129 DARTMOUTH',
    merchant: 'Cineplex',
    categoryId: 'entertainment',
    account: 'amex',
    mean: 41,
    sd: 12,
    perMonth: 0.5,
  },
  {
    descriptor: 'AIR CANADA 0142',
    merchant: 'Air Canada',
    categoryId: 'travel',
    account: 'amex',
    mean: 540,
    sd: 220,
    perMonth: 0.17,
  },
  {
    descriptor: 'AIRBNB * HMK2R',
    merchant: 'Airbnb',
    categoryId: 'travel',
    account: 'amex',
    mean: 620,
    sd: 250,
    perMonth: 0.12,
  },
  {
    descriptor: 'INTACT INSURANCE',
    merchant: 'Intact',
    categoryId: 'car',
    account: 'rbc-chq',
    mean: 164,
    sd: 0,
    perMonth: 1,
  },
  {
    descriptor: 'HALIFAX TRANSIT',
    merchant: 'Halifax Transit',
    categoryId: 'transit',
    account: 'td-visa',
    mean: 2.75,
    sd: 0,
    perMonth: 4,
  },
  {
    descriptor: 'LITTLE SPROUTS DAYCARE',
    merchant: 'Little Sprouts',
    categoryId: 'kids',
    account: 'rbc-chq',
    mean: 1180,
    sd: 10,
    perMonth: 1,
    from: '2024-01-01',
  },
  {
    descriptor: 'E-TRANSFER SENT',
    merchant: 'e-Transfer',
    categoryId: 'gifts',
    account: 'rbc-chq',
    mean: 90,
    sd: 60,
    perMonth: 0.8,
  },
  {
    descriptor: 'LANDLORD RENT PAD',
    merchant: 'Rent',
    categoryId: 'rent',
    account: 'rbc-chq',
    mean: 1850,
    sd: 0,
    perMonth: 1,
    to: '2022-06-01',
  },
  {
    descriptor: 'RBC MORTGAGE PYMT',
    merchant: 'Mortgage',
    categoryId: 'mortgage-pay',
    account: 'rbc-chq',
    mean: 2640,
    sd: 0,
    perMonth: 2,
    from: '2022-07-01',
  },
];

const UNKNOWN_DESCRIPTORS = [
  'SQ *BLUE NOSE GOODS',
  'PAYPAL *STEAMGAMES',
  'TST* CHAIN YARD CIDER',
  'LAWTONS DRUGS 0117',
  'HFX SEAPORT MARKET VEND',
  'PROPELLER BREWING CO',
  'POS PURCHASE 4411',
  'CANADIAN TIRE #0118',
  'WSIB*PARKING HFX',
  'ZEHRS? NO: SOBEYS LIQUOR',
];

/** The synthetic ledger and the import preview waiting on it. */
export type Synthetic = { ledger: Ledger; preview: ImportPreview };

/**
 * The preview's rows are October's exports; they are not in the ledger until
 * the preview is applied, exactly as with a server.
 */
export function buildLedger(seed = 1337): Synthetic {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = 1 - rnd();
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const amount = (mean: number, sd: number) =>
    round2(Math.max(1, mean + gauss() * sd));

  const months = monthsBetween(START, END);
  const txns: Transaction[] = [];
  let seq = 0;
  const id = () => `t${(++seq).toString(36).padStart(5, '0')}`;
  const batchFor = (d: string) => `b-${d.slice(0, 4)}`;

  const push = (
    t: Omit<
      Transaction,
      'id' | 'batchId' | 'tags' | 'transferId' | 'source' | 'confidence'
    > &
      Partial<
        Pick<Transaction, 'tags' | 'transferId' | 'source' | 'confidence'>
      >,
  ) => {
    txns.push({
      id: id(),
      tags: [],
      transferId: null,
      source: 'rule',
      confidence: null,
      batchId: batchFor(t.date),
      ...t,
    });
  };

  // Salary: twice a month, grows a little each January.
  for (const m of months) {
    const year = m.getUTCFullYear();
    const net = 3900 + (year - 2021) * 190;
    for (const day of [15, 28]) {
      const d = new Date(Date.UTC(year, m.getUTCMonth(), day));
      if (d > END) continue;
      push({
        accountId: 'rbc-chq',
        date: iso(d),
        amount: net,
        descriptor: 'PAYROLL DEPOSIT ACME SYSTEMS',
        merchant: 'Acme Systems',
        categoryId: 'salary',
      });
    }
    // Partner income, monthly from 2023.
    if (year >= 2023) {
      const d = new Date(Date.UTC(year, m.getUTCMonth(), 25));
      if (d <= END)
        push({
          accountId: 'rbc-chq',
          date: iso(d),
          amount: 2850,
          descriptor: 'NSHA PAYROLL',
          merchant: 'NSHA',
          categoryId: 'salary',
        });
    }
    // Interest on savings.
    const di = new Date(Date.UTC(year, m.getUTCMonth() + 1, 0));
    if (di <= END)
      push({
        accountId: 'rbc-sav',
        date: iso(di),
        amount: round2(18 + rnd() * 40 + (year - 2021) * 12),
        descriptor: 'INTEREST CREDIT',
        merchant: 'RBC',
        categoryId: 'interest',
      });
  }

  // Merchant spend.
  for (const spec of MERCHANTS) {
    for (const m of months) {
      const ms = iso(m);
      if (spec.from && ms < `${spec.from.slice(0, 7)}-01`) continue;
      if (spec.to && ms > spec.to) continue;
      const n =
        spec.perMonth >= 1
          ? Math.round(spec.perMonth + (rnd() - 0.5))
          : rnd() < spec.perMonth
            ? 1
            : 0;
      for (let k = 0; k < n; k++) {
        const d = addDays(m, Math.floor(rnd() * 28));
        if (d > END) continue;
        push({
          accountId: spec.account,
          date: iso(d),
          amount: -amount(spec.mean, spec.sd),
          descriptor: spec.descriptor,
          merchant: spec.merchant,
          categoryId: spec.categoryId,
          source: rnd() < 0.15 ? 'model' : 'rule',
          confidence: null,
        });
      }
    }
  }
  for (const t of txns)
    if (t.source === 'model') t.confidence = round2(0.72 + rnd() * 0.27);

  // A handful of uncategorised oddities each year.
  for (const m of months) {
    if (rnd() < 0.25) {
      const d = addDays(m, Math.floor(rnd() * 28));
      if (d > END) continue;
      const desc =
        UNKNOWN_DESCRIPTORS[Math.floor(rnd() * UNKNOWN_DESCRIPTORS.length)];
      push({
        accountId: rnd() < 0.5 ? 'amex' : 'td-visa',
        date: iso(d),
        amount: -amount(45, 30),
        descriptor: desc,
        merchant: desc
          .replace(/^(SQ \*|TST\* |PAYPAL \*)/, '')
          .replace(/\s+\d+$/, ''),
        categoryId: 'uncategorized',
        source: 'model',
        confidence: round2(0.35 + rnd() * 0.3),
      });
    }
  }

  // Credit-card payments: pay last month's balance from chequing, both legs.
  for (const card of ['amex', 'td-visa']) {
    for (const m of months.slice(1)) {
      const prev = new Date(
        Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 1),
      );
      const pm = iso(prev).slice(0, 7);
      const owed = txns
        .filter(
          (t) => t.accountId === card && t.date.startsWith(pm) && t.amount < 0,
        )
        .reduce((s, t) => s - t.amount, 0);
      if (owed < 1) continue;
      const d = addDays(m, 4);
      if (d > END) continue;
      const xid = `x-${card}-${pm}`;
      push({
        accountId: 'rbc-chq',
        date: iso(d),
        amount: -round2(owed),
        descriptor: card === 'amex' ? 'AMEX PAYMENT' : 'TD VISA PAYMENT',
        merchant: card === 'amex' ? 'Amex' : 'TD',
        categoryId: 'cc-payment',
        transferId: xid,
      });
      push({
        accountId: card,
        date: iso(addDays(d, 1)),
        amount: round2(owed),
        descriptor: 'PAYMENT - THANK YOU',
        merchant: card === 'amex' ? 'Amex' : 'TD',
        categoryId: 'cc-payment',
        transferId: xid,
      });
    }
  }

  // Savings and investment contributions, both legs.
  for (const m of months) {
    const d = addDays(m, 1);
    if (d > END) continue;
    const ym = iso(m).slice(0, 7);
    const sv = 500;
    push({
      accountId: 'rbc-chq',
      date: iso(d),
      amount: -sv,
      descriptor: 'TFR TO SAVINGS',
      merchant: 'RBC',
      categoryId: 'savings-xfer',
      transferId: `x-sav-${ym}`,
    });
    push({
      accountId: 'rbc-sav',
      date: iso(d),
      amount: sv,
      descriptor: 'TFR FROM CHEQUING',
      merchant: 'RBC',
      categoryId: 'savings-xfer',
      transferId: `x-sav-${ym}`,
    });
    const tf = 400;
    push({
      accountId: 'rbc-chq',
      date: iso(d),
      amount: -tf,
      descriptor: 'WEALTHSIMPLE INVESTMENTS',
      merchant: 'Wealthsimple',
      categoryId: 'invest-xfer',
      transferId: `x-tfsa-${ym}`,
    });
    push({
      accountId: 'ws-tfsa',
      date: iso(addDays(d, 2)),
      amount: tf,
      descriptor: 'CONTRIBUTION',
      merchant: 'Wealthsimple',
      categoryId: 'invest-xfer',
      transferId: `x-tfsa-${ym}`,
    });
    if (m.getUTCMonth() === 1) {
      const rr = 6000;
      push({
        accountId: 'rbc-sav',
        date: iso(d),
        amount: -rr,
        descriptor: 'QUESTRADE RRSP',
        merchant: 'Questrade',
        categoryId: 'invest-xfer',
        transferId: `x-rrsp-${ym}`,
      });
      push({
        accountId: 'qt-rrsp',
        date: iso(addDays(d, 3)),
        amount: rr,
        descriptor: 'RRSP CONTRIBUTION',
        merchant: 'Questrade',
        categoryId: 'invest-xfer',
        transferId: `x-rrsp-${ym}`,
      });
    }
  }

  // House purchase: down payment out of savings, mortgage principal.
  push({
    accountId: 'rbc-sav',
    date: '2022-06-15',
    amount: -95000,
    descriptor: 'BR TO BR - LAWYER TRUST',
    merchant: 'Down payment',
    categoryId: 'home',
    tags: ['house'],
  });

  // The old Scotiabank account: a thin 2021 history, closed in March 2022.
  for (const m of months.filter((m) => iso(m) < '2022-04')) {
    const d = addDays(m, 10);
    push({
      accountId: 'scotia-old',
      date: iso(d),
      amount: -amount(60, 25),
      descriptor: 'POS PURCHASE',
      merchant: 'Unknown POS',
      categoryId: 'uncategorized',
      source: 'model',
      confidence: 0.41,
    });
  }
  push({
    accountId: 'scotia-old',
    date: '2022-03-30',
    amount: -1120.55,
    descriptor: 'ACCOUNT CLOSE TRANSFER',
    merchant: 'Scotiabank',
    categoryId: 'transfer',
    transferId: 'x-close',
  });
  push({
    accountId: 'rbc-chq',
    date: '2022-03-31',
    amount: 1120.55,
    descriptor: 'INCOMING WIRE SCOTIA',
    merchant: 'Scotiabank',
    categoryId: 'transfer',
    transferId: 'x-close',
  });

  txns.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1,
  );

  // Holdings: quarterly snapshots. Early ones come from scanned statements.
  const holdings: HoldingSnapshot[] = [];
  const quarters = months.filter((m) => m.getUTCMonth() % 3 === 2);
  let tfsaUnits = 180;
  let rrspUnits = 95;
  let xeqt = 24.1;
  let veqt = 31.2;
  for (const q of quarters) {
    const d = iso(
      new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth() + 1, 0)),
    );
    if (d > iso(END)) break;
    xeqt = round2(xeqt * (1 + 0.025 + gauss() * 0.06));
    veqt = round2(veqt * (1 + 0.024 + gauss() * 0.06));
    tfsaUnits += 1200 / xeqt;
    if (q.getUTCMonth() === 2) rrspUnits += 6000 / veqt;
    const origin = d < '2024-01-01' ? 'statement-pdf' : 'export';
    const tf: HoldingSnapshot = {
      accountId: 'ws-tfsa',
      date: d,
      origin,
      positions: [
        {
          symbol: 'XEQT',
          name: 'iShares Core Equity ETF',
          quantity: round2(tfsaUnits),
          price: xeqt,
          marketValue: round2(tfsaUnits * xeqt),
          bookCost: round2(tfsaUnits * 24.5),
        },
      ],
      total: 0,
    };
    tf.total = tf.positions.reduce((s, p) => s + p.marketValue, 0);
    const cash = round2(1200 + rnd() * 900);
    const rr: HoldingSnapshot = {
      accountId: 'qt-rrsp',
      date: d,
      origin,
      positions: [
        {
          symbol: 'VEQT',
          name: 'Vanguard All-Equity ETF',
          quantity: round2(rrspUnits),
          price: veqt,
          marketValue: round2(rrspUnits * veqt),
          bookCost: round2(rrspUnits * 30.1),
        },
        {
          symbol: 'CASH',
          name: 'Cash',
          quantity: cash,
          price: 1,
          marketValue: cash,
          bookCost: cash,
        },
      ],
      total: 0,
    };
    rr.total = round2(rr.positions.reduce((s, p) => s + p.marketValue, 0));
    holdings.push(tf, rr);
  }

  // House valuations and mortgage balance assertions.
  const valuations: Valuation[] = [
    {
      accountId: 'house',
      date: '2022-06-15',
      value: 612000,
      source: 'purchase',
    },
    {
      accountId: 'house',
      date: '2023-01-01',
      value: 598000,
      source: 'assessment',
    },
    {
      accountId: 'house',
      date: '2024-01-01',
      value: 641000,
      source: 'assessment',
    },
    {
      accountId: 'house',
      date: '2025-01-01',
      value: 668000,
      source: 'assessment',
    },
    {
      accountId: 'house',
      date: '2026-01-01',
      value: 684000,
      source: 'assessment',
    },
    {
      accountId: 'house',
      date: '2026-09-01',
      value: 705000,
      source: 'estimate',
    },
  ];
  const assertions: BalanceAssertion[] = [];
  let principal = 517000;
  for (const m of months.filter((m) => iso(m) >= '2022-07')) {
    const d = iso(
      new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)),
    );
    if (d > iso(END)) break;
    principal = round2(principal - (2640 * 2 - principal * (0.0489 / 12)));
    assertions.push({
      accountId: 'mortgage',
      date: d,
      balance: -principal,
      ok: true,
    });
  }
  // One chequing statement that does not reconcile: a missing export.
  assertions.push({
    accountId: 'rbc-chq',
    date: '2023-08-31',
    balance: 7412.18,
    ok: false,
  });
  assertions.push({
    accountId: 'rbc-chq',
    date: '2025-12-31',
    balance: 9120.4,
    ok: true,
  });

  const batches: ImportBatch[] = Array.from(new Set(txns.map((t) => t.batchId)))
    .sort()
    .map((b, i) => ({
      id: b,
      importedAt: `2026-10-${String(18 + i).padStart(2, '0')}`,
      files: 4 + (i % 3),
      rows: txns.filter((t) => t.batchId === b).length,
      note: i === 0 ? 'Backfill from QFX + the Scotiabank CSV' : 'Backfill',
    }));

  const rules: Rule[] = MERCHANTS.map((m, i) => ({
    id: `r${i}`,
    match: m.descriptor.split(' ').slice(0, 2).join(' '),
    categoryId: m.categoryId,
    merchant: m.merchant,
    createdFrom: i % 4 === 0 ? 'correction' : 'seed',
    hits: txns.filter((t) => t.merchant === m.merchant).length,
  }));

  // Import preview: October's new exports plus one scanned statement.
  const previewTxns = txns.filter((t) => t.date >= '2026-10-01');
  const dupA = previewTxns.find((t) => t.merchant === 'Sobeys');
  const dupB = previewTxns.find((t) => t.merchant === 'Amazon');
  const low = previewTxns.filter(
    (t) => t.categoryId === 'uncategorized' || (t.confidence ?? 1) < 0.8,
  );
  const xfer = previewTxns.find((t) => t.descriptor === 'AMEX PAYMENT');
  const xferIn = previewTxns.find(
    (t) => t.transferId === xfer?.transferId && t.id !== xfer?.id,
  );
  const findings: Finding[] = [];
  if (dupA)
    findings.push({
      kind: 'duplicate',
      id: 'f1',
      transactionId: dupA.id,
      matchesId: txns.find(
        (t) => t.merchant === 'Sobeys' && t.date < '2026-10-01',
      )!.id,
      reason:
        'Same account, amount and date already imported from the QFX on 2026-10-18',
    });
  if (dupB)
    findings.push({
      kind: 'duplicate',
      id: 'f2',
      transactionId: dupB.id,
      matchesId: txns.find(
        (t) => t.merchant === 'Amazon' && t.date < '2026-10-01',
      )!.id,
      reason: 'Pending row re-posted with a different descriptor',
    });
  findings.push({
    kind: 'missing-period',
    id: 'f3',
    accountId: 'rbc-chq',
    from: '2023-07-01',
    to: '2023-08-31',
    expectedBalance: 7412.18,
    actualBalance: 6907.9,
  });
  if (xfer && xferIn)
    findings.push({
      kind: 'transfer',
      id: 'f4',
      outId: xfer.id,
      inId: xferIn.id,
      daysApart: 1,
    });
  for (const [i, t] of low.entries())
    findings.push({
      kind: 'low-confidence',
      id: `f${5 + i}`,
      transactionId: t.id,
      suggestedCategoryId:
        t.categoryId === 'uncategorized' ? 'shopping' : t.categoryId,
      confidence: t.confidence ?? 0.5,
    });
  const outbound = Array.from(new Set(low.map((t) => t.descriptor)));

  const preview: ImportPreview = {
    id: 'synthetic',
    files: [
      {
        name: 'rbc-chequing-2026-10.qfx',
        format: 'qfx',
        institution: 'RBC',
        accountId: 'rbc-chq',
        rows: previewTxns.filter((t) => t.accountId === 'rbc-chq').length,
        from: '2026-10-01',
        to: '2026-10-24',
      },
      {
        name: 'amex-activity.csv',
        format: 'csv',
        institution: 'Amex',
        accountId: 'amex',
        rows: previewTxns.filter((t) => t.accountId === 'amex').length,
        from: '2026-09-28',
        to: '2026-10-23',
      },
      {
        name: 'td-visa-download.csv',
        format: 'csv',
        institution: 'TD',
        accountId: null,
        rows: previewTxns.filter((t) => t.accountId === 'td-visa').length,
        from: '2026-10-01',
        to: '2026-10-22',
      },
      {
        name: 'Questrade_Statement_2021-09.pdf',
        format: 'pdf',
        institution: 'Questrade',
        accountId: 'qt-rrsp',
        rows: 2,
        from: '2021-07-01',
        to: '2021-09-30',
        pages: 6,
        scanned: true,
      },
    ],
    newTransactions: previewTxns,
    findings,
    outboundStrings: outbound,
    rulesHit: previewTxns.length - low.length,
    modelCalls: outbound.length,
  };

  const incoming = new Set(previewTxns.map((t) => t.id));
  const kept = txns.filter((t) => !incoming.has(t.id));
  return {
    ledger: {
      owner: 'jon@lolwtf.ca',
      viewers: ['partner@lolwtf.ca'],
      accounts: ACCOUNTS,
      categories: CATEGORIES,
      transactions: kept,
      holdings,
      valuations,
      assertions,
      batches: batches.filter((b) => kept.some((t) => t.batchId === b.id)),
      rules,
      asOf: kept.reduce((m, t) => (t.date > m ? t.date : m), ''),
    },
    preview,
  };
}
