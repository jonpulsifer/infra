/**
 * The signed repository webhook, which the internet can reach. Nothing parses a
 * body before its HMAC matches, and an unknown event is ignored without an error.
 */
import { describe, expect, test } from 'bun:test';
import {
  handleWebhookDelivery,
  parseWebhookDelivery,
  verifyWebhookSignature,
  WebhookRejected,
} from '../../../src/integrations/github/webhook.ts';

const SECRET = 'a shared secret nobody else has';

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  const hex = Array.from(mac, (byte) => byte.toString(16).padStart(2, '0'));
  return `sha256=${hex.join('')}`;
}

function delivery(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return {
    body,
    bytes: new TextEncoder().encode(body),
    event,
  };
}

const push = {
  ref: 'refs/heads/main',
  after: '1111111111111111111111111111111111111111',
  repository: { full_name: 'example/app', default_branch: 'main' },
  installation: { id: 4242 },
};

describe('signature verification', () => {
  test('accepts a delivery signed with this installation’s secret', async () => {
    const { body, bytes } = delivery('push', push);
    await expect(
      verifyWebhookSignature(bytes, await sign(body), SECRET),
    ).resolves.toBeUndefined();
  });

  test.each([
    ['no signature at all', null, 'SIGNATURE_MISSING'],
    ['an empty signature', '', 'SIGNATURE_MISSING'],
    ['a signature with no scheme', 'deadbeef', 'SIGNATURE_MALFORMED'],
    ['a signature that is not hex', 'sha256=zzzz', 'SIGNATURE_MALFORMED'],
  ] as const)('refuses %s', async (_name, signature, code) => {
    const { bytes } = delivery('push', push);
    const verified = verifyWebhookSignature(bytes, signature, SECRET);
    await expect(verified).rejects.toBeInstanceOf(WebhookRejected);
    await expect(verified).rejects.toMatchObject({ code });
  });

  test('refuses a signature made with a different secret', async () => {
    const { body, bytes } = delivery('push', push);
    const verified = verifyWebhookSignature(
      bytes,
      await sign(body, 'somebody else’s secret'),
      SECRET,
    );
    await expect(verified).rejects.toMatchObject({
      code: 'SIGNATURE_MISMATCH',
    });
  });

  test('refuses a body altered after it was signed', async () => {
    const { body } = delivery('push', push);
    const signature = await sign(body);
    const tampered = new TextEncoder().encode(
      body.replace('refs/heads/main', 'refs/heads/evil'),
    );
    await expect(
      verifyWebhookSignature(tampered, signature, SECRET),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
  });
});

describe('the whole endpoint', () => {
  test('does not parse an unsigned body', async () => {
    // Not JSON, so a parser running before verification would refuse it first.
    const handled = handleWebhookDelivery(
      {
        event: 'push',
        signature: null,
        body: new TextEncoder().encode('{not json'),
      },
      SECRET,
    );
    await expect(handled).rejects.toMatchObject({ code: 'SIGNATURE_MISSING' });
  });

  test('refuses a signed body that is not JSON', async () => {
    const body = '{not json';
    const handled = handleWebhookDelivery(
      {
        event: 'push',
        signature: await sign(body),
        body: new TextEncoder().encode(body),
      },
      SECRET,
    );
    await expect(handled).rejects.toMatchObject({ code: 'BODY_MALFORMED' });
  });

  test('refuses a signed delivery that names no event', async () => {
    const { body, bytes } = delivery('push', push);
    const handled = handleWebhookDelivery(
      { event: null, signature: await sign(body), body: bytes },
      SECRET,
    );
    await expect(handled).rejects.toMatchObject({ code: 'EVENT_MISSING' });
  });

  test('classifies a verified push', async () => {
    const { body, bytes } = delivery('push', push);
    await expect(
      handleWebhookDelivery(
        { event: 'push', signature: await sign(body), body: bytes },
        SECRET,
      ),
    ).resolves.toEqual({
      kind: 'push',
      repository: 'example/app',
      ref: 'refs/heads/main',
      defaultBranch: 'main',
      head: push.after,
    });
  });
});

describe('classification', () => {
  test('a push carries its ref rather than a verdict about it', () => {
    // The loop compares the ref against the stored default branch.
    expect(
      parseWebhookDelivery('push', { ...push, ref: 'refs/heads/topic' }),
    ).toMatchObject({ kind: 'push', ref: 'refs/heads/topic' });
  });

  test('refuses a push missing what a push is', () => {
    expect(() =>
      parseWebhookDelivery('push', {
        repository: { full_name: 'example/app' },
      }),
    ).toThrow(WebhookRejected);
  });

  test.each([
    ['deleted', 'the GitHub App installation was deleted'],
    ['suspend', 'the GitHub App installation was suspended'],
  ] as const)(
    'installation.%s is lost access to everything',
    (action, detail) => {
      expect(
        parseWebhookDelivery('installation', {
          action,
          installation: { id: 4242 },
        }),
      ).toEqual({
        kind: 'accessLost',
        installationId: '4242',
        // Empty means every repository of the installation.
        repositories: [],
        detail,
      });
    },
  );

  test('installation.unsuspend is restored access', () => {
    expect(
      parseWebhookDelivery('installation', {
        action: 'unsuspend',
        installation: { id: 4242 },
      }),
    ).toEqual({
      kind: 'accessRestored',
      installationId: '4242',
      repositories: [],
    });
  });

  test('a removed repository is lost access to that repository only', () => {
    expect(
      parseWebhookDelivery('installation_repositories', {
        action: 'removed',
        installation: { id: 4242 },
        repositories_removed: [{ full_name: 'example/app' }],
      }),
    ).toMatchObject({
      kind: 'accessLost',
      installationId: '4242',
      repositories: ['example/app'],
    });
  });

  test('an added repository is restored access', () => {
    expect(
      parseWebhookDelivery('installation_repositories', {
        action: 'added',
        installation: { id: 4242 },
        repositories_added: [{ full_name: 'example/app' }],
      }),
    ).toMatchObject({ kind: 'accessRestored', repositories: ['example/app'] });
  });

  test.each([
    ['ping', {}],
    ['issues', { action: 'opened', installation: { id: 4242 } }],
    [
      'installation',
      { action: 'new_permissions_accepted', installation: { id: 4242 } },
    ],
    [
      'installation_repositories',
      { action: 'added', installation: { id: 4242 } },
    ],
  ] as const)('ignores %s rather than throwing', (event, payload) => {
    const parsed = parseWebhookDelivery(event, payload);
    expect(parsed.kind).toBe('ignored');
  });

  test('refuses a body that is not an object', () => {
    expect(() => parseWebhookDelivery('push', 'a string')).toThrow(
      WebhookRejected,
    );
  });
});
