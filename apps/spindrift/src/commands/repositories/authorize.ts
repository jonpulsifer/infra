import { z } from 'zod';
import { type Command, failed, ok } from '../types.ts';

export const beginRepositoryAuthorizationInput = z.object({}).strict();
export type BeginRepositoryAuthorizationInput = z.infer<
  typeof beginRepositoryAuthorizationInput
>;

export interface BeginRepositoryAuthorizationResult {
  readonly attemptId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export const beginRepositoryAuthorization: Command<
  BeginRepositoryAuthorizationInput,
  BeginRepositoryAuthorizationResult
> = async (_input, context) => {
  const authorization = context.adapters.repositoryAuthorization?.() ?? null;
  if (authorization === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no encrypted repository authorization store',
    );
  }
  const challenge = await authorization.begin(context.principal.id);
  return ok({
    ...challenge,
    expiresAt: challenge.expiresAt.toISOString(),
  });
};

export const pollRepositoryAuthorizationInput = z
  .object({ attemptId: z.uuid() })
  .strict();
export type PollRepositoryAuthorizationInput = z.infer<
  typeof pollRepositoryAuthorizationInput
>;

export type PollRepositoryAuthorizationResult =
  | {
      readonly state: 'pending';
      readonly retryAfterSeconds: number;
      readonly expiresAt: string;
    }
  | { readonly state: 'authorized'; readonly login: string }
  | { readonly state: 'expired' | 'denied' };

export const pollRepositoryAuthorization: Command<
  PollRepositoryAuthorizationInput,
  PollRepositoryAuthorizationResult
> = async (input, context) => {
  const authorization = context.adapters.repositoryAuthorization?.() ?? null;
  if (authorization === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no encrypted repository authorization store',
    );
  }
  const result = await authorization.poll(
    context.principal.id,
    input.attemptId,
  );
  return ok(
    result.state === 'pending'
      ? { ...result, expiresAt: result.expiresAt.toISOString() }
      : result,
  );
};
