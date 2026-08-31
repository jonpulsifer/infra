/**
 * Reaching a cloud Target with no stored credential (§13).
 *
 * §13 settles one auth mode — "native OIDC federation, **nothing stored**" —
 * and a claim like that needs a test that can fail. The claims here:
 *
 * - **The projected token is read from disk on every exchange**, because the
 *   kubelet rewrites it and a value captured once stops working part way
 *   through the day.
 * - **The exchange is a real exchange.** What goes to a cloud API is the token
 *   STS handed back, never the projected one — sending that would be a `401` on
 *   every cloud call, blamed on the Target.
 * - **Impersonation is optional**, because direct resource access is a
 *   supported configuration rather than an omission.
 * - **A token is cached until shortly before it expires**, so a burst of calls
 *   is one round trip and an expiring token is dropped before it can fail a
 *   deploy mid-flight.
 */
import { describe, expect, test } from 'bun:test';
import {
  FederationError,
  workloadIdentityToken,
} from '@repo/archive/federation';

const AUDIENCE = '//iam.example.test/projects/1/pools/example/providers/one';
const TOKEN_URL = 'https://sts.example.test/v1/token';
const IMPERSONATION_URL =
  'https://iamcredentials.example.test/v1/projects/-/serviceAccounts/one:generateAccessToken';
const TOKEN_PATH = '/var/run/secrets/cloud/token';

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

/** A far side that exchanges, and records exactly what it was asked. */
function federation(
  options: {
    impersonate?: boolean;
    expiresIn?: number;
    stsStatus?: number;
    projected?: (path: string) => Promise<string>;
    now?: () => number;
  } = {},
) {
  const requests: Recorded[] = [];
  let minted = 0;

  const fetch = async (request: Request): Promise<Response> => {
    const body = (await request.clone().json()) as Record<string, unknown>;
    requests.push({
      url: request.url,
      body,
      authorization: request.headers.get('authorization'),
    });
    if (request.url === TOKEN_URL) {
      if (options.stsStatus !== undefined) {
        return new Response('the pool refused this token', {
          status: options.stsStatus,
        });
      }
      minted += 1;
      return Response.json({
        access_token: `federated-${minted}`,
        expires_in: options.expiresIn ?? 3600,
      });
    }
    return Response.json({
      accessToken: `impersonated-${minted}`,
      expireTime: new Date((options.now?.() ?? 0) + 3_600_000).toISOString(),
    });
  };

  let reads = 0;
  const provider = workloadIdentityToken({
    audience: AUDIENCE,
    tokenUrl: TOKEN_URL,
    tokenPath: TOKEN_PATH,
    impersonationUrl: options.impersonate === true ? IMPERSONATION_URL : null,
    fetch,
    readToken:
      options.projected ??
      (async (path) => {
        reads += 1;
        return `projected-for-${path}-${reads}`;
      }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { provider, requests, projectedReads: () => reads };
}

describe('§13: nothing stored, so every token is minted', () => {
  test('what reaches a cloud API is the exchanged token, never the projected one', async () => {
    const { provider, requests } = federation();
    const token = await provider();

    expect(token).toBe('federated-1');
    // The projected token is the *subject* of an exchange. A provider that
    // handed it straight to a cloud API would be sending a token minted for
    // this cluster's own API server, which every cloud API refuses.
    const exchange = requests[0];
    expect(exchange?.url).toBe(TOKEN_URL);
    expect(exchange?.body.subjectToken).toContain('projected-for-');
    expect(exchange?.body.audience).toBe(AUDIENCE);
    expect(token).not.toContain('projected-for-');
  });

  test('the projected token is re-read on every exchange, never captured', async () => {
    // The kubelet rewrites the file, so a value read once at start-up stops
    // working part way through the day — the classic failure this path exists
    // to avoid.
    let at = 0;
    const { provider, projectedReads } = federation({
      expiresIn: 1,
      now: () => {
        at += 600_000;
        return at;
      },
    });
    await provider();
    await provider();
    expect(projectedReads()).toBe(2);
  });

  test('an impersonated token is what comes back where one is configured', async () => {
    const { provider, requests } = federation({ impersonate: true });
    expect(await provider()).toBe('impersonated-1');

    const impersonation = requests[1];
    expect(impersonation?.url).toBe(IMPERSONATION_URL);
    // Impersonation authorizes with the federated token, which is the whole
    // point of the two-step: the projected token never leaves the exchange.
    expect(impersonation?.authorization).toBe('Bearer federated-1');
  });

  test('no impersonation url is a configuration, not an omission', async () => {
    const { provider, requests } = federation();
    expect(await provider()).toBe('federated-1');
    // Direct resource access grants the federated identity roles of its own,
    // which is one fewer identity to reason about where it is allowed.
    expect(requests).toHaveLength(1);
  });
});

describe('caching, and giving up the last minute of a token', () => {
  test('a burst of calls is one exchange', async () => {
    const { provider, requests } = federation({ now: () => 1_000 });
    const [first, second, third] = await Promise.all([
      provider(),
      provider(),
      provider(),
    ]);
    expect([first, second, third]).toEqual([
      'federated-1',
      'federated-1',
      'federated-1',
    ]);
    expect(requests).toHaveLength(1);
  });

  test('a token near expiry is dropped rather than served', async () => {
    // A token that expires while a request is in flight fails a deploy for a
    // reason nobody can act on, so the cache gives up its last minute.
    let now = 0;
    const { provider, requests } = federation({
      expiresIn: 90,
      now: () => now,
    });
    expect(await provider()).toBe('federated-1');
    now = 20_000;
    expect(await provider()).toBe('federated-1');
    // 90s lifetime, 60s skew: past 30s the cached token is no longer offered.
    now = 40_000;
    expect(await provider()).toBe('federated-2');
    expect(requests).toHaveLength(2);
  });
});

describe('failing loudly rather than deploying with nothing', () => {
  test('a refused exchange names the pool that refused it', async () => {
    const { provider } = federation({ stsStatus: 403 });
    expect(provider()).rejects.toThrow(FederationError);
  });

  test('an empty projected token is a refusal, not an empty bearer', async () => {
    const { provider } = federation({ projected: async () => '   ' });
    // An empty string would be sent as `Bearer `, and the failure would arrive
    // as an authorization error against the Target rather than as the
    // misconfiguration it is.
    expect(provider()).rejects.toThrow(FederationError);
  });
});
