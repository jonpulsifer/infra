/**
 * The visitor: an anonymous id in a cookie signed over site and id, so it
 * cannot be chosen. `__Host-` forbids a `Domain`, so one site host cannot set a
 * cookie its siblings would send; the zone is not on the Public Suffix List.
 */
import { createHmac } from 'node:crypto';

import { timingSafeEquals } from './http.ts';

export const ME_COOKIE = '__Host-kthx_me';
const ME_LIFETIME_S = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Me {
  readonly id: string;
  /** `null` when the request carried a cookie signed by the live key. */
  readonly setCookie: string | null;
}

function sign(key: string, site: string, id: string): string {
  return createHmac('sha256', key)
    .update(`me:${site}:${id}`)
    .digest('base64url');
}

/** Every value under this name: a duplicated cookie mints a new visitor. */
function cookies(request: Request, name: string): string[] {
  const found: string[] = [];
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) found.push(rest.join('='));
  }
  return found;
}

/**
 * `previous` verifies but never signs, so rotating `KTHX_ME_KEY` re-signs each
 * visitor's cookie on their next call and keeps their id.
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
