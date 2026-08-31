/**
 * Credential administration (§"credential administration and recovery").
 *
 * Every mutation begins with a fresh assertion from an enrolled passkey. The
 * tests keep the existing session/principal separate from that assertion so a
 * linked Gateway session cannot accidentally become an account root.
 */
import { describe, expect, test } from 'bun:test';
import { base64urlDecode, base64urlEncode } from '@repo/archive/bytes';
import {
  beginAddPasskey,
  beginCredentialChange,
  type CredentialAdminDeps,
  completeAddPasskey,
  linkGatewayIdentity,
  removePasskey,
  unlinkGatewayIdentity,
} from '../../src/auth/credential-admin.ts';
import { beginEnrolment, completeEnrolment } from '../../src/auth/enrol.ts';
import { gatewayIdentityKey } from '../../src/auth/gateway.ts';
import type { Principal } from '../../src/commands/types.ts';
import { credentials, users } from '../../src/db/schema.ts';
import {
  type Authenticator,
  createAuthenticator,
} from '../harness/authenticator.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const TOKEN = 'the-token-in-the-installation-secret';
const RELYING_PARTY = {
  id: 'spindrift.example.test',
  name: 'Spindrift',
  origin: 'https://spindrift.example.test',
} as const;
const GATEWAY = {
  adapterKey: 'front-door',
  issuer: 'https://issuer.example.test',
  subjectHeader: 'x-auth-request-subject',
  displayNameHeader: 'x-auth-request-name',
} as const;

function deps(): CredentialAdminDeps {
  return {
    db: database().db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    relyingParty: RELYING_PARTY,
    gateway: GATEWAY,
  };
}

async function enrolled(): Promise<{
  principal: Principal;
  root: Authenticator;
}> {
  const auth = createAuthenticator({
    rpId: RELYING_PARTY.id,
    origin: RELYING_PARTY.origin,
  });
  const begun = await beginEnrolment(
    { ...deps(), enrolmentToken: TOKEN },
    { token: TOKEN },
  );
  expect(begun.ok).toBe(true);
  if (!begun.ok) throw new Error('enrolment did not begin');

  const root = await auth;
  const complete = await completeEnrolment(
    { ...deps(), enrolmentToken: TOKEN },
    { token: TOKEN, ...(await root.register(begun.value.challenge)) },
  );
  expect(complete.ok).toBe(true);
  if (!complete.ok) throw new Error('enrolment did not complete');
  return { principal: complete.value.principal, root };
}

async function fresh(principal: Principal, root: Authenticator) {
  const begun = await beginCredentialChange(deps(), principal);
  return root.assert(begun.challenge);
}

/**
 * Flip a byte inside the DER-encoded signature payload so the assertion
 * decodes to different bytes and fails cryptographic verification.
 *
 * The signature is `base64urlEncode(derEncode(r || s))`
 * (`test/harness/authenticator.ts`), and a DER-encoded ECDSA signature is
 * usually not a multiple of three bytes — so editing the *encoded string*
 * (e.g. overwriting its last character) can land in slack bits that decode
 * back to the original bytes about one run in eight. Decoding, XOR-ing the
 * final byte of the DER blob — which is always the low byte of the `s`
 * integer, never the tag/length framing `derToRawEcdsa` reads structurally —
 * and re-encoding guarantees both a different decoded value on every run and
 * a signature that genuinely fails `crypto.subtle.verify`.
 */
function forgeSignature(signature: string): string {
  const bytes = base64urlDecode(signature);
  if (!bytes) throw new Error('signature did not decode');
  const mutated = new Uint8Array(bytes);
  mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 0xff;
  return base64urlEncode(mutated);
}

describe('adding a passkey', () => {
  test('requires a fresh root assertion, then adds rather than replaces', async () => {
    const { principal, root } = await enrolled();
    const authorized = await beginAddPasskey(
      deps(),
      principal,
      await fresh(principal, root),
    );
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    const additional = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });
    const completed = await completeAddPasskey(deps(), principal, {
      ...(await additional.register(authorized.value.challenge)),
    });

    expect(completed.ok).toBe(true);
    expect(await database().db.select().from(credentials)).toHaveLength(2);
  });

  test('cannot use another User as the owner of an issued challenge', async () => {
    const { principal, root } = await enrolled();
    const assertion = await fresh(principal, root);
    const stranger = {
      id: crypto.randomUUID(),
      displayName: 'Not the operator',
    };

    const result = await beginAddPasskey(deps(), stranger, assertion);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('CHALLENGE_UNKNOWN');
  });
});

describe('removing a passkey', () => {
  test('never removes the final account root', async () => {
    const { principal, root } = await enrolled();
    const [only] = await database().db.select().from(credentials);

    const result = await removePasskey(deps(), principal, {
      credentialId: only!.credentialId,
      assertion: await fresh(principal, root),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('LAST_PASSKEY');
    expect(await database().db.select().from(credentials)).toHaveLength(1);
  });

  test('removes one of several after a fresh assertion', async () => {
    const { principal, root } = await enrolled();
    const begun = await beginAddPasskey(
      deps(),
      principal,
      await fresh(principal, root),
    );
    if (!begun.ok) throw new Error('add did not begin');
    const additional = await createAuthenticator({
      rpId: RELYING_PARTY.id,
      origin: RELYING_PARTY.origin,
    });
    await completeAddPasskey(deps(), principal, {
      ...(await additional.register(begun.value.challenge)),
    });

    const result = await removePasskey(deps(), principal, {
      credentialId: additional.credentialId,
      assertion: await fresh(principal, root),
    });

    expect(result.ok).toBe(true);
    const remaining = await database().db.select().from(credentials);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.credentialId).toBe(root.credentialId);
  });
});

describe('the Gateway binding', () => {
  test('links and unlinks only behind fresh passkey assertions', async () => {
    const { principal, root } = await enrolled();
    const gatewayRequest = new Request(RELYING_PARTY.origin, {
      headers: { [GATEWAY.subjectHeader]: 'subject-123' },
    });

    const linked = await linkGatewayIdentity(
      deps(),
      principal,
      gatewayRequest,
      await fresh(principal, root),
    );
    expect(linked.ok).toBe(true);
    let [user] = await database().db.select().from(users);
    expect(user?.gatewayIdentity).toBe(
      gatewayIdentityKey(GATEWAY, 'subject-123'),
    );

    const unlinked = await unlinkGatewayIdentity(
      deps(),
      principal,
      await fresh(principal, root),
    );
    expect(unlinked.ok).toBe(true);
    [user] = await database().db.select().from(users);
    expect(user?.gatewayIdentity).toBeNull();
  });

  test('does not link when the fresh assertion is invalid', async () => {
    const { principal, root } = await enrolled();
    const assertion = await fresh(principal, root);
    const forged = {
      ...assertion,
      signature: forgeSignature(assertion.signature),
    };

    const result = await linkGatewayIdentity(
      deps(),
      principal,
      new Request(RELYING_PARTY.origin, {
        headers: { [GATEWAY.subjectHeader]: 'subject-123' },
      }),
      { ...forged, credentialId: root.credentialId },
    );
    expect(result.ok).toBe(false);
    expect(
      (await database().db.select().from(users))[0]?.gatewayIdentity,
    ).toBeNull();
  });
});
