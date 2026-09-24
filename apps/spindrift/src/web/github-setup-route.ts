/**
 * The target of GitHub's App-creation and installation redirects. Both reach
 * the operator's browser, so both need the session. Never log or cache the
 * query: it carries the one-time conversion code and the session nonce.
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
   * `null` where this installation holds no keyring or database. Resolved per
   * request, since the manifest and App rows change at runtime.
   */
  auth(): Promise<GitHubAppAuth | null>;
}

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
  // The manifest conversion: `state` must match this session, and an existing
  // App row refuses it.
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

  // Untrusted per GitHub's docs, so it only prompts a re-enumeration.
  if (url.searchParams.has('installation_id')) {
    return seeRepositories();
  }

  return respond(400, 'nothing to do: neither leg of the setup flow arrived');
}
