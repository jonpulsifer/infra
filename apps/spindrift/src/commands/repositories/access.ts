/**
 * Why a repository was not read, in a sentence the operator can act on.
 *
 * §15's three access codes are three different facts and only one of them is
 * about this repository, so they refuse differently: a lost grant is a fact
 * about the installation, a quota refusal is a fact about the hour, and
 * anything else is a fact about GitHub having a bad time. Collapsing the last
 * two into `NOT_FOUND` sends somebody to check a repository that is there.
 *
 * No response body ever reaches the message. The far side answers a failed read
 * with JSON or with somebody's proxy error page, and neither is a sentence.
 *
 * `ACCESS_LOST` states both of its possibilities because there are two and
 * GitHub answers identically for them (`integrations/github/http.ts`): a
 * repository that does not exist and one this installation is not granted are
 * the same `404`, so naming only the second asserts an existence nothing here
 * established.
 *
 * Shared by `inspectRepository` and `connectRepository` because the creation
 * flow runs both against the same repository — reading it on selection and
 * connecting it on Deploy — and two taxonomies for one act would mean the same
 * quota window reads as a missing repository depending on which button the
 * operator had reached.
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
