/**
 * Which Google account this machine is, as the apex wants to hear it.
 *
 * `gcloud auth print-identity-token` already mints exactly the credential the
 * server verifies, and every machine that talks to this zone has gcloud on it.
 * So there is no login flow here, no client secret, and nothing stored: one
 * shell-out, kept in memory until the token's own `exp`.
 *
 * `KTHX_IDENTITY_TOKEN` is the way in for a machine that has no gcloud — CI, a
 * container, a service account minting its own — and is used verbatim.
 */
import { KthxError } from './error.ts';

/** Re-mint this long before `exp`, so a call never carries a token that dies mid-flight. */
const EARLY_MS = 60_000;
/** What a token whose `exp` cannot be read is trusted for. */
const BLIND_MS = 5 * 60_000;

let held: { token: string; until: number } | null = null;

/** The ID token owner-scoped calls carry. */
export async function identityToken(): Promise<string> {
  const given = process.env.KTHX_IDENTITY_TOKEN?.trim();
  if (given) return given;
  if (held !== null && Date.now() < held.until) return held.token;
  const token = await mint();
  held = { token, until: expiryOf(token) };
  return token;
}

/** Drop the kept token. For tests, and for nothing else. */
export function forgetIdentity(): void {
  held = null;
}

async function mint(): Promise<string> {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn(['gcloud', 'auth', 'print-identity-token'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Explicit, because Bun resolves the binary against the environment it
      // is handed rather than against the one this process is in now — and a
      // `PATH` a caller changed is the whole of how this is tested.
      env: process.env,
    });
  } catch {
    throw refused('gcloud is not on PATH');
  }
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const token = out.trim();
  if (code !== 0 || token === '') {
    throw refused(
      firstLine(err) || 'gcloud auth print-identity-token printed nothing',
    );
  }
  return token;
}

const refused = (why: string) =>
  new KthxError(
    'NO_IDENTITY',
    `${why}; kthx owns sites by google account — run gcloud auth login`,
  );

const firstLine = (text: string): string =>
  text.trim().split('\n')[0]?.trim() ?? '';

/**
 * When this token stops being worth sending.
 *
 * The payload is read, never trusted — the server is what verifies it. A token
 * this cannot parse is still used, for a few minutes, because a shape this does
 * not know is the server's business and not a reason to refuse to try.
 */
function expiryOf(token: string): number {
  const part = token.split('.')[1];
  if (part === undefined) return Date.now() + BLIND_MS;
  try {
    const payload = JSON.parse(
      Buffer.from(part, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return Date.now() + BLIND_MS;
    return payload.exp * 1000 - EARLY_MS;
  } catch {
    return Date.now() + BLIND_MS;
  }
}
