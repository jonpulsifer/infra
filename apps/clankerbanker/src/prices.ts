import type { Network } from '@x402/core/types';

export const BASE: Network = 'eip155:8453';
export const SOLANA: Network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** `METHOD /path` → [price, what it returns]. The routes map and the page
 * are both rendered from this table. */
export const PRICES: Record<string, [string, string]> = {
  'GET /fortune': ['$0.001', 'a robot fortune'],
  'GET /premium/fortune': ['$0.10', 'the same fortune, tier: premium'],
  'GET /oracle': ['$0.0005', 'a magic 8-ball answer'],
  'GET /dice': ['$0.001', 'a d20 roll, provably fair to the payer'],
  'GET /ping': ['$0.0001', 'pong'],
  'GET /whoami': ['$0.0001', 'your lifetime stats on this ledger'],
  'GET /tip/:name': ['$0.005', 'a name on the tips ticker'],
  'GET /tip/:name/big': ['$0.25', 'the same ticker, but you meant it'],
  'GET /tip/:name/whale': ['$5.00', 'a whale-sized thank you'],
  'GET /tip/:name/everything': ['$100.00', 'your balance, basically; A-OK'],
  'PUT /kv/:key': ['$0.001', 'stores up to 4 KiB, per payer'],
  'GET /kv/:key': ['$0.0001', 'reads it back'],
  'POST /account': ['$1.00', 'a 24h bearer pass for every route'],
  'GET /ask': ['$0.01', 'one model answer to ?q=, 80 words, no memory'],
  'GET /roast/:address': ['$0.01', 'a wallet roast from its balances'],
};
