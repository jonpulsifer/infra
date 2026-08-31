/**
 * The visitor: an anonymous id a site can remember someone by, signed so it
 * cannot be chosen.
 *
 * v1 handed out a bare uuid and believed whatever came back. That is enough to
 * count votes and no more: anyone could send someone else's id, and every
 * per-visitor bound — the write bucket, the socket cap, a file's owner — would
 * be one header away from being nothing. So the cookie carries an HMAC over
 * the site and the id, and a cookie that does not verify is replaced rather
 * than trusted.
 *
 * `__Host-` because `kthx.dev` is not on the Public Suffix List: a browser
 * refuses to store such a cookie with a `Domain`, which is what stops one site
 * host from writing a cookie its siblings would send.
 */
import { createHmac } from 'node:crypto';

import { timingSafeEquals } from './http.ts';

export const ME_COOKIE = '__Host-kthx_me';
const ME_LIFETIME_S = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who this browser is, and the header that says so when it was not yet. */
export interface Me {
  readonly id: string;
  /** Absent when the request already carried a cookie signed by the live key. */
  readonly setCookie: string | null;
}

function sign(key: string, site: string, id: string): string {
  return createHmac('sha256', key)
    .update(`me:${site}:${id}`)
    .digest('base64url');
}

/** Every value sent under this name, so a duplicate is caught rather than picked. */
function cookies(request: Request, name: string): string[] {
  const found: string[] = [];
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) found.push(rest.join('='));
  }
  return found;
}

/**
 * The visitor this request is, minting one when it is nobody yet.
 *
 * `previous` verifies but never signs, so rotating `KTHX_ME_KEY` re-mints each
 * visitor's cookie on their next call instead of forgetting who they are.
 */
export function meOf(
  request: Request,
  site: string,
  key: string,
  previous: string | null = null,
): Me {
  const sent = cookies(request, ME_COOKIE);
  if (sent.length === 1) {
    const [id = '', signature = ''] = (sent[0] ?? '').split('.');
    if (UUID.test(id)) {
      if (timingSafeEquals(signature, sign(key, site, id)))
        return { id, setCookie: null };
      // Signed by the key this deployment has just rotated away from: the
      // visitor keeps their id and is handed a cookie under the live key.
      if (
        previous !== null &&
        timingSafeEquals(signature, sign(previous, site, id))
      ) {
        return { id, setCookie: cookie(id, sign(key, site, id)) };
      }
    }
  }
  const id = crypto.randomUUID();
  return { id, setCookie: cookie(id, sign(key, site, id)) };
}

function cookie(id: string, signature: string): string {
  return `${ME_COOKIE}=${id}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ME_LIFETIME_S}`;
}
