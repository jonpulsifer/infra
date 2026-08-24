const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type Chain = 'base' | 'solana';
export type Balances = { native: string; usdc: string };

export const chainOf = (address: string): Chain | undefined =>
  /^0x[0-9a-fA-F]{40}$/.test(address)
    ? 'base'
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
      ? 'solana'
      : undefined;

async function rpc<T>(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (!res.ok || body.error || body.result === undefined)
    throw new Error(`rpc ${method} failed`);
  return body.result;
}

const units = (v: bigint, decimals: number) => {
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals))
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};

/** Native + USDC balances from a public RPC; throws when unreachable. */
export async function balances(
  chain: Chain,
  address: string,
): Promise<Balances> {
  if (chain === 'base') {
    const url = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
    const [wei, usdc] = await Promise.all([
      rpc<string>(url, 'eth_getBalance', [address, 'latest']),
      rpc<string>(url, 'eth_call', [
        {
          to: USDC_BASE,
          data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`,
        },
        'latest',
      ]),
    ]);
    return { native: units(BigInt(wei), 18), usdc: units(BigInt(usdc), 6) };
  }
  const url =
    process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const [sol, accounts] = await Promise.all([
    rpc<{ value: number }>(url, 'getBalance', [address]),
    rpc<{
      value: {
        account: {
          data: { parsed: { info: { tokenAmount: { amount: string } } } };
        };
      }[];
    }>(url, 'getTokenAccountsByOwner', [
      address,
      { mint: USDC_SOLANA },
      { encoding: 'jsonParsed' },
    ]),
  ]);
  const usdc = accounts.value.reduce(
    (t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
  return { native: units(BigInt(sol.value), 9), usdc: units(usdc, 6) };
}
