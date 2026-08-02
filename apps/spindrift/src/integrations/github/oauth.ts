/**
 * GitHub App Device Flow and the durable user credential it produces.
 *
 * This module is the credential lifecycle. Repository and Actions callers ask
 * only for an Authorization value; they do not know whether the access token
 * was refreshed, re-encrypted, or recovered from a legacy key.
 */
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { equalText } from '../../auth/bytes.ts';
import type { Clock } from '../../commands/types.ts';
import type { CredentialKeyring } from '../../crypto/credential-envelope.ts';
import type { Database } from '../../db/client.ts';
import {
  githubDeviceAuthorizations,
  githubOAuthCredentials,
} from '../../db/schema.ts';
import type {
  RepositoryAuthorizationChallenge,
  RepositoryAuthorizationPoll,
  RepositoryAuthorizationStatus,
} from '../../domain/repository.ts';
import { RepositoryAuthorizationRequiredError } from '../../domain/repository.ts';
import type { Fetcher } from './http.ts';

const deviceResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});

const tokenSuccess = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

const tokenFailure = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

const credentialPayload = z
  .object({
    accessToken: z.string().min(1),
    tokenType: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
  })
  .strict();

const githubUser = z.object({
  id: z.union([z.string(), z.number()]),
  login: z.string().min(1),
});

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SLOW_DOWN_SECONDS = 5;
const SINGLETON_ID = 1;

export interface GitHubOAuthOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly keyring: CredentialKeyring;
  readonly clientId: string;
  readonly oauthBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly fetch?: Fetcher;
}

export class GitHubOAuthError extends Error {
  override readonly name = 'GitHubOAuthError';
}

type TokenExchange =
  | { readonly kind: 'success'; readonly value: z.infer<typeof tokenSuccess> }
  | {
      readonly kind: 'failure';
      readonly error: string;
      readonly description: string | null;
    };

type CredentialResult =
  | {
      readonly kind: 'authorized';
      readonly accessToken: string;
      readonly tokenType: string;
    }
  | { readonly kind: 'unauthorized' };

export class GitHubDeviceOAuth {
  constructor(private readonly options: GitHubOAuthOptions) {}

  async status(): Promise<RepositoryAuthorizationStatus> {
    const row = await this.options.db.query.githubOAuthCredentials.findFirst({
      where: (credential, { eq: equal }) => equal(credential.id, SINGLETON_ID),
    });
    if (row === undefined || this.isIrrecoverablyExpired(row)) {
      return { state: 'unauthorized' };
    }
    return {
      state: 'authorized',
      login: row.githubLogin,
      githubUserId: row.githubUserId,
    };
  }

  async principalSubject(installationId: string): Promise<string> {
    const status = await this.status();
    if (status.state !== 'authorized') {
      throw new RepositoryAuthorizationRequiredError(
        'GitHub authorization is required',
      );
    }
    return `installation:${installationId}/user:${status.githubUserId}`;
  }

  async begin(userId: string): Promise<RepositoryAuthorizationChallenge> {
    const now = this.options.clock.now();
    await this.options.db
      .delete(githubDeviceAuthorizations)
      .where(lt(githubDeviceAuthorizations.expiresAt, now));

    const issued = deviceResponse.parse(
      await this.form('/login/device/code', {
        client_id: this.options.clientId,
      }),
    );
    const expiresAt = new Date(now.getTime() + issued.expires_in * 1000);
    const nextPollAt = new Date(now.getTime() + issued.interval * 1000);
    const [attempt] = await this.options.db
      .insert(githubDeviceAuthorizations)
      .values({
        userId,
        encryptedDeviceCode: await this.options.keyring.seal(
          issued.device_code,
          'spindrift-github-device-code',
        ),
        verificationUri: issued.verification_uri,
        intervalSeconds: issued.interval,
        nextPollAt,
        expiresAt,
        createdAt: now,
      })
      .returning();

    return {
      attemptId: attempt!.id,
      userCode: issued.user_code,
      verificationUri: issued.verification_uri,
      expiresAt,
      intervalSeconds: issued.interval,
    };
  }

  async poll(
    userId: string,
    attemptId: string,
  ): Promise<RepositoryAuthorizationPoll> {
    return this.options.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(githubDeviceAuthorizations)
        .where(
          and(
            eq(githubDeviceAuthorizations.id, attemptId),
            eq(githubDeviceAuthorizations.userId, userId),
          ),
        )
        .for('update');
      if (attempt === undefined) return { state: 'expired' as const };

      const now = this.options.clock.now();
      if (attempt.expiresAt.getTime() <= now.getTime()) {
        await tx
          .delete(githubDeviceAuthorizations)
          .where(eq(githubDeviceAuthorizations.id, attempt.id));
        return { state: 'expired' as const };
      }
      if (attempt.nextPollAt.getTime() > now.getTime()) {
        return {
          state: 'pending' as const,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((attempt.nextPollAt.getTime() - now.getTime()) / 1000),
          ),
          expiresAt: attempt.expiresAt,
        };
      }

      const opened = await this.options.keyring.open(
        attempt.encryptedDeviceCode,
        'spindrift-github-device-code',
      );
      const exchanged = await this.exchange({
        client_id: this.options.clientId,
        device_code: opened.plaintext,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      if (exchanged.kind === 'failure') {
        if (
          exchanged.error === 'expired_token' ||
          exchanged.error === 'access_denied'
        ) {
          await tx
            .delete(githubDeviceAuthorizations)
            .where(eq(githubDeviceAuthorizations.id, attempt.id));
          return {
            state:
              exchanged.error === 'access_denied'
                ? ('denied' as const)
                : ('expired' as const),
          };
        }
        if (
          exchanged.error === 'authorization_pending' ||
          exchanged.error === 'slow_down'
        ) {
          const intervalSeconds =
            attempt.intervalSeconds +
            (exchanged.error === 'slow_down' ? SLOW_DOWN_SECONDS : 0);
          await tx
            .update(githubDeviceAuthorizations)
            .set({
              intervalSeconds,
              nextPollAt: new Date(now.getTime() + intervalSeconds * 1000),
              ...(opened.needsRotation
                ? {
                    encryptedDeviceCode: await this.options.keyring.seal(
                      opened.plaintext,
                      'spindrift-github-device-code',
                    ),
                  }
                : {}),
            })
            .where(eq(githubDeviceAuthorizations.id, attempt.id));
          return {
            state: 'pending' as const,
            retryAfterSeconds: intervalSeconds,
            expiresAt: attempt.expiresAt,
          };
        }
        throw new GitHubOAuthError(
          exchanged.description ??
            `GitHub refused the device authorization: ${exchanged.error}`,
        );
      }

      const identity = await this.user(
        exchanged.value.token_type,
        exchanged.value.access_token,
      );
      const credential = credentialPayload.parse({
        accessToken: exchanged.value.access_token,
        tokenType: exchanged.value.token_type,
        refreshToken: exchanged.value.refresh_token ?? null,
      });
      const accessExpiresAt =
        exchanged.value.expires_in === undefined
          ? null
          : new Date(now.getTime() + exchanged.value.expires_in * 1000);
      const refreshExpiresAt =
        exchanged.value.refresh_token_expires_in === undefined
          ? null
          : new Date(
              now.getTime() + exchanged.value.refresh_token_expires_in * 1000,
            );
      const encryptedCredential = await this.options.keyring.seal(
        JSON.stringify(credential),
        'spindrift-github-oauth-credential',
      );

      await tx
        .insert(githubOAuthCredentials)
        .values({
          id: SINGLETON_ID,
          githubUserId: String(identity.id),
          githubLogin: identity.login,
          encryptedCredential,
          accessExpiresAt,
          refreshExpiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: githubOAuthCredentials.id,
          set: {
            githubUserId: String(identity.id),
            githubLogin: identity.login,
            encryptedCredential,
            accessExpiresAt,
            refreshExpiresAt,
            updatedAt: now,
          },
        });
      await tx
        .delete(githubDeviceAuthorizations)
        .where(eq(githubDeviceAuthorizations.id, attempt.id));
      return { state: 'authorized' as const, login: identity.login };
    });
  }

  /** A fresh Authorization header value for one GitHub API request. */
  async authorization(): Promise<string> {
    const result = await this.credential();
    if (result.kind === 'unauthorized') {
      throw new RepositoryAuthorizationRequiredError(
        'GitHub authorization is required',
      );
    }
    return `${result.tokenType} ${result.accessToken}`;
  }

  /**
   * Turn an API `401` into connector reauthorization, not repository loss.
   *
   * Delete only when the rejected value is still current. A request carrying
   * an older token can finish after another process refreshed or reauthorized;
   * it must not erase the replacement credential.
   */
  async rejectedAuthorization(authorization: string): Promise<Error> {
    const rejected = authorization.replace(/^[^ ]+ +/, '');
    await this.options.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(githubOAuthCredentials)
        .where(eq(githubOAuthCredentials.id, SINGLETON_ID))
        .for('update');
      if (row === undefined) return;
      const opened = await this.options.keyring.open(
        row.encryptedCredential,
        'spindrift-github-oauth-credential',
      );
      const payload = credentialPayload.parse(JSON.parse(opened.plaintext));
      if (equalText(payload.accessToken, rejected)) {
        await tx
          .delete(githubOAuthCredentials)
          .where(eq(githubOAuthCredentials.id, SINGLETON_ID));
      }
    });
    return new RepositoryAuthorizationRequiredError(
      'GitHub rejected this authorization; authorize the App again',
    );
  }

  private async credential(): Promise<CredentialResult> {
    return this.options.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(githubOAuthCredentials)
        .where(eq(githubOAuthCredentials.id, SINGLETON_ID))
        .for('update');
      if (row === undefined || this.isIrrecoverablyExpired(row)) {
        return { kind: 'unauthorized' as const };
      }

      const opened = await this.options.keyring.open(
        row.encryptedCredential,
        'spindrift-github-oauth-credential',
      );
      let payload = credentialPayload.parse(JSON.parse(opened.plaintext));
      const now = this.options.clock.now();
      const needsRefresh =
        row.accessExpiresAt !== null &&
        row.accessExpiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_MS;

      if (!needsRefresh) {
        if (opened.needsRotation) {
          await tx
            .update(githubOAuthCredentials)
            .set({
              encryptedCredential: await this.options.keyring.seal(
                JSON.stringify(payload),
                'spindrift-github-oauth-credential',
              ),
              updatedAt: now,
            })
            .where(eq(githubOAuthCredentials.id, SINGLETON_ID));
        }
        return {
          kind: 'authorized' as const,
          accessToken: payload.accessToken,
          tokenType: payload.tokenType,
        };
      }

      if (
        payload.refreshToken === null ||
        (row.refreshExpiresAt !== null &&
          row.refreshExpiresAt.getTime() <= now.getTime())
      ) {
        return { kind: 'unauthorized' as const };
      }

      const refreshed = await this.exchange({
        client_id: this.options.clientId,
        grant_type: 'refresh_token',
        refresh_token: payload.refreshToken,
      });
      if (refreshed.kind === 'failure') {
        if (
          refreshed.error === 'bad_refresh_token' ||
          refreshed.error === 'incorrect_client_credentials'
        ) {
          return { kind: 'unauthorized' as const };
        }
        throw new GitHubOAuthError(
          refreshed.description ??
            `GitHub refused the credential refresh: ${refreshed.error}`,
        );
      }

      payload = credentialPayload.parse({
        accessToken: refreshed.value.access_token,
        tokenType: refreshed.value.token_type,
        refreshToken: refreshed.value.refresh_token ?? payload.refreshToken,
      });
      const accessExpiresAt =
        refreshed.value.expires_in === undefined
          ? null
          : new Date(now.getTime() + refreshed.value.expires_in * 1000);
      const refreshExpiresAt =
        refreshed.value.refresh_token_expires_in === undefined
          ? row.refreshExpiresAt
          : new Date(
              now.getTime() + refreshed.value.refresh_token_expires_in * 1000,
            );
      await tx
        .update(githubOAuthCredentials)
        .set({
          encryptedCredential: await this.options.keyring.seal(
            JSON.stringify(payload),
            'spindrift-github-oauth-credential',
          ),
          accessExpiresAt,
          refreshExpiresAt,
          updatedAt: now,
        })
        .where(eq(githubOAuthCredentials.id, SINGLETON_ID));

      return {
        kind: 'authorized' as const,
        accessToken: payload.accessToken,
        tokenType: payload.tokenType,
      };
    });
  }

  private isIrrecoverablyExpired(row: {
    readonly accessExpiresAt: Date | null;
    readonly refreshExpiresAt: Date | null;
  }): boolean {
    const now = this.options.clock.now().getTime();
    return (
      row.accessExpiresAt !== null &&
      row.accessExpiresAt.getTime() <= now &&
      row.refreshExpiresAt !== null &&
      row.refreshExpiresAt.getTime() <= now
    );
  }

  private async user(tokenType: string, accessToken: string) {
    const response = await this.send(
      new Request(`${this.options.apiBaseUrl}/user`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `${tokenType} ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
    );
    if (!response.ok) {
      throw new GitHubOAuthError(
        `GitHub user lookup failed with ${response.status}`,
      );
    }
    return githubUser.parse(await response.json());
  }

  private async exchange(
    fields: Record<string, string>,
  ): Promise<TokenExchange> {
    const body = await this.form('/login/oauth/access_token', fields);
    const success = tokenSuccess.safeParse(body);
    if (success.success) return { kind: 'success', value: success.data };
    const failure = tokenFailure.safeParse(body);
    if (failure.success) {
      return {
        kind: 'failure',
        error: failure.data.error,
        description: failure.data.error_description ?? null,
      };
    }
    throw new GitHubOAuthError(
      'GitHub returned an unrecognized token response',
    );
  }

  private async form(
    path: string,
    fields: Record<string, string>,
  ): Promise<unknown> {
    const response = await this.send(
      new Request(`${this.options.oauthBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields),
      }),
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null) {
      throw new GitHubOAuthError(
        `GitHub OAuth endpoint ${path} failed with ${response.status}`,
      );
    }
    return body;
  }

  private send(request: Request): Promise<Response> {
    return (this.options.fetch ?? ((input: Request) => fetch(input)))(request);
  }
}
