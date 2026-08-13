/**
 * Where GitHub's App-creation and installation flows land (§15).
 *
 * One path, two legs, told apart by which query parameter arrived:
 *
 * - **`code=`** is the manifest conversion — it arrives exactly once, right
 *   after the operator clicks create on GitHub's confirmation page. The
 *   `state` nonce is checked against the acting session (it is the one leg
 *   whose callback is believed), the code is converted, and the returned key
 *   is sealed into the `github_app` row. Refused outright when a row already
 *   exists: replacing the App identity is a deliberate act, not a side effect
 *   of resubmitting the create flow.
 * - **`installation_id=`** is the install/reconfigure callback. The docs say
 *   not to trust the parameter, so nothing from it is believed — it is a pure
 *   "refresh now" signal, answered by sending the operator back to the
 *   Repositories screen, which re-enumerates through the App JWT.
 *
 * Session-authenticated, unlike the webhook beside it: both legs arrive in
 * the operator's own browser, which carries the session cookie. Responses are
 * `Cache-Control: no-store` — the conversion response upstream of this route
 * is the only place the App's key ever exists as plaintext outside GitHub,
 * and nothing about this exchange belongs in a cache. Nothing here logs the
 * query string; telemetry records the route path alone.
 */
import type { RequestAuthentication } from '../auth/types.ts';
import {
  type GitHubAppAuth,
  GitHubAppSetupError,
} from '../integrations/github/app-auth.ts';

export const GITHUB_SETUP_PATH = '/internal/github/setup';

export interface GitHubSetupRouteDeps {
  authenticate(request: Request): Promise<RequestAuthentication>;
  /**
   * The auth agent over the current manifest, or `null` where this
   * installation holds no keyring or database. Resolved per request for the
   * same reason the webhook secret is: the manifest row and the App row both
   * change mid-flight.
   */
  auth(): Promise<GitHubAppAuth | null>;
}

/** Every answer this route gives carries the no-store posture. */
function respond(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function seeRepositories(): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: '/repos', 'Cache-Control': 'no-store' },
  });
}

export function githubSetupRoutes(
  deps: GitHubSetupRouteDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return {
    [GITHUB_SETUP_PATH]: (request: Request) => handleSetup(request, deps),
  };
}

async function handleSetup(
  request: Request,
  deps: GitHubSetupRouteDeps,
): Promise<Response> {
  if (request.method !== 'GET') {
    return respond(405, 'GitHub redirects here with GET');
  }
  const authentication = await deps.authenticate(request);
  if (authentication.kind !== 'authenticated') {
    return respond(
      401,
      'this landing needs the session that started the flow; sign in and start again from the Repositories screen',
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (code !== null) {
    const auth = await deps.auth();
    if (auth === null) {
      return respond(
        503,
        'this installation has no credential keyring, so it has nowhere to seal an App key',
      );
    }
    try {
      await auth.convertManifestCode({
        code,
        state: url.searchParams.get('state'),
        userId: authentication.principal.id,
      });
    } catch (cause) {
      if (cause instanceof GitHubAppSetupError) {
        return respond(cause.status, cause.message);
      }
      throw cause;
    }
    return seeRepositories();
  }

  if (url.searchParams.has('installation_id')) {
    return seeRepositories();
  }

  return respond(400, 'nothing to do: neither leg of the setup flow arrived');
}
