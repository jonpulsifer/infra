/**
 * Site name rules, shared by the claim route and the CLI. A separate file keeps
 * the CLI from importing the control API.
 */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Common hostnames, the path prefixes reserved on site hosts, and Postgres
 * names: a site name also becomes a database and a role.
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
