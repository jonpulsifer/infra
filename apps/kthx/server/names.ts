/**
 * What makes a name a name.
 *
 * Its own file because both ends check it: the claim route refuses a bad name,
 * and the CLI refuses to build a URL out of one before it ever asks. Importing
 * `sites.ts` for this would pull the whole control API — the depot, the pools,
 * the migrations — into a command line that needs a regex.
 */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Names nobody may claim.
 *
 * Three groups: the hostnames a zone owes itself, the path prefixes reserved on
 * every site host (a site called `files` would still be reachable, but the
 * confusion is not worth the label), and the Postgres identifiers a site name
 * becomes — a name is also a database and a role, so `postgres` and the
 * templates are taken before anyone asks.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'mail',
  'ftp',
  'sdk',
  'static',
  'assets',
  'cdn',
  'fn',
  'dev',
  'test',
  'staging',
  'kthx',
  'lolwtf',
  'spindrift',
  'root',
  'internal',
  '_',
  'files',
  'client',
  'ai',
  'mcp',
  'cli',
  'postgres',
  'template0',
  'template1',
  'template_kthx',
  'kthx_site',
  'public',
  'none',
]);

/** Why a name cannot be claimed, or `null`. */
export function nameProblem(name: string): 'INVALID_NAME' | 'RESERVED' | null {
  if (name.length < 3 || name.length > 40 || !NAME_PATTERN.test(name)) {
    return 'INVALID_NAME';
  }
  return RESERVED_NAMES.has(name) ? 'RESERVED' : null;
}
