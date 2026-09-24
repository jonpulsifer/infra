/**
 * Why a repository was not read, as a refusal the operator can act on. Lost
 * access, quota and outages refuse differently, and no response body reaches
 * the message.
 */
import { GitHubAccessError } from '../../integrations/github/http.ts';
import { type CommandResult, failed } from '../types.ts';

export function unreadable<Output>(
  fullName: string,
  cause: unknown,
): CommandResult<Output> {
  if (cause instanceof GitHubAccessError) {
    switch (cause.code) {
      case 'ACCESS_LOST':
        return failed(
          'NOT_FOUND',
          `Spindrift cannot reach ${fullName}. GitHub answers the same way for a repository that does not exist and for one this App installation does not select, so it is one of those two: check the name, then the installation's repository selection.`,
        );
      case 'RATE_LIMITED':
        return failed(
          'NOT_DEPLOYABLE',
          `GitHub is rate-limiting Spindrift, so ${fullName} was not read. Nothing is wrong with the repository — try again once the quota resets.`,
        );
      case 'UNAVAILABLE':
        return failed(
          'NOT_DEPLOYABLE',
          `GitHub answered ${cause.status} for ${fullName}. That is the far side rather than the repository — try again.`,
        );
    }
  }
  return failed(
    'NOT_DEPLOYABLE',
    `Spindrift could not read ${fullName}: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  );
}
