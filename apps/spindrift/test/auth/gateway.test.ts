/**
 * The optional authenticated-Gateway adapter (Task 37, identity story 5).
 *
 * These tests stand at the adapter's public request boundary. The Gateway is the
 * far side: normalized headers are its verdict, while the database binding and
 * stable `User` are Spindrift's side. No provider token appears here because the
 * adapter deliberately trusts the non-bypassable Gateway rather than
 * re-implementing its provider flow.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  assertedGatewayIdentity,
  authenticateRequest,
  type GatewayDeps,
  gatewayIdentityKey,
  readSessionState,
} from '../../src/auth/gateway.ts';
import { openSession, SESSION_COOKIE } from '../../src/auth/session.ts';
import type { Principal } from '../../src/commands/types.ts';
import { credentials, users } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

const GATEWAY = {
  adapterKey: 'front-door',
  issuer: 'https://issuer.example.test',
  subjectHeader: 'x-auth-request-subject',
  displayNameHeader: 'x-auth-request-name',
} as const;

const deps = (gateway: GatewayDeps['gateway'] = GATEWAY): GatewayDeps => ({
  db: database().db,
  clock: { now: () => new Date('2026-01-01T00:00:00Z') },
  relyingParty: {
    id: 'spindrift.example.test',
    name: 'example',
    origin: 'https://spindrift.example.test',
  },
  gateway,
});

const request = (subject: string | null, extra: Record<string, string> = {}) =>
  new Request('https://spindrift.example.test', {
    headers: {
      ...(subject === null ? {} : { [GATEWAY.subjectHeader]: subject }),
      ...extra,
    },
  });

async function operator(): Promise<Principal> {
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return { id: user!.id, displayName: user!.displayName };
}

beforeEach(() => database());

describe('resolving a Gateway assertion', () => {
  test('a bound issuer and subject authenticate the stable User', async () => {
    const principal = await operator();
    await database()
      .db.update(users)
      .set({
        gatewayIdentity: gatewayIdentityKey(GATEWAY, 'subject-123'),
      });

    expect(
      await authenticateRequest(
        request('subject-123', {
          [GATEWAY.displayNameHeader]: 'A provider display name',
        }),
        deps(),
      ),
    ).toEqual({ kind: 'authenticated', principal });
  });

  test('an unknown assertion is forbidden rather than provisioned', async () => {
    await operator();

    expect(await authenticateRequest(request('stranger'), deps())).toEqual({
      kind: 'forbidden',
      message:
        'that Gateway identity is not linked to the operator on this installation',
    });
    expect(await database().db.select().from(users)).toHaveLength(1);
  });

  test('headers are inert when the adapter is disabled', async () => {
    const principal = await operator();
    await database()
      .db.update(users)
      .set({ gatewayIdentity: gatewayIdentityKey(GATEWAY, 'subject-123') });

    expect(
      await authenticateRequest(request('subject-123'), deps(null)),
    ).toEqual({ kind: 'anonymous' });
    expect(principal.id).toBeString();
  });

  test('a local session remains valid while an unknown Gateway is being linked', async () => {
    const principal = await operator();
    const session = await openSession(deps(), principal);
    const withBoth = request('not-linked-yet', {
      cookie: `${SESSION_COOKIE}=${session.token}`,
    });

    expect(await authenticateRequest(withBoth, deps())).toEqual({
      kind: 'authenticated',
      principal,
    });
  });

  test('an unlinked assertion can still discover passkey sign-in', async () => {
    const principal = await operator();
    await database().db.insert(credentials).values({
      userId: principal.id,
      credentialId: 'credential-1',
      publicKey: 'public-key',
      algorithm: -7,
    });

    expect(await readSessionState(request('not-linked-yet'), deps())).toEqual({
      principal: null,
      claimed: true,
      gatewayUnlinked: true,
    });
  });
});

describe('reading the current Gateway assertion', () => {
  test('returns its opaque key without mutating the User', async () => {
    const principal = await operator();
    expect(assertedGatewayIdentity(deps(), request('subject-123'))).toEqual({
      ok: true,
      value: gatewayIdentityKey(GATEWAY, 'subject-123'),
    });
    const [stored] = await database().db.select().from(users);
    expect(stored?.id).toBe(principal.id);
    expect(stored?.gatewayIdentity).toBeNull();
  });

  test('refuses a request carrying no trusted assertion', async () => {
    const result = assertedGatewayIdentity(deps(), request(null));

    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'GATEWAY_ASSERTION_MISSING',
        message:
          'the trusted Gateway did not supply an identity to link on this request',
      },
    });
  });
});
