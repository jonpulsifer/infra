/**
 * The signed repository webhook: verifies a delivery, then classifies it for
 * the repo loop. An unrecognized event is `ignored` with a reason, never thrown.
 */

export const SIGNATURE_HEADER = 'X-Hub-Signature-256';
export const EVENT_HEADER = 'X-GitHub-Event';

export type WebhookDelivery =
  | {
      /** Any ref; the loop decides whether it is the default branch. */
      readonly kind: 'push';
      /** `owner/name`. */
      readonly repository: string;
      /** The full ref, such as `refs/heads/main`. */
      readonly ref: string;
      readonly defaultBranch: string;
      /** The commit the ref now points at. */
      readonly head: string;
    }
  | {
      readonly kind: 'accessLost';
      readonly installationId: string;
      /** Empty means every repository of the installation. */
      readonly repositories: readonly string[];
      /** Shown to the operator on the frozen repository. */
      readonly detail: string;
    }
  | {
      readonly kind: 'accessRestored';
      readonly installationId: string;
      /** Empty means every repository of the installation. */
      readonly repositories: readonly string[];
    }
  | {
      readonly kind: 'ignored';
      /** For a log line. */
      readonly reason: string;
    };

export type WebhookRejectionCode =
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_MISMATCH'
  | 'EVENT_MISSING'
  | 'BODY_MALFORMED';

/**
 * An unauthenticated or malformed delivery, answered `4xx`. An `ignored`
 * delivery was authenticated and is answered `202`.
 */
export class WebhookRejected extends Error {
  override readonly name = 'WebhookRejected';

  constructor(
    readonly code: WebhookRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

const SIGNATURE_PREFIX = 'sha256=';

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant time over equal lengths. The early length check leaks only the size
 * of a SHA-256 HMAC, which is public.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Checks the HMAC over the raw bytes, since a parser round trip can change a
 * byte the sender signed.
 */
export async function verifyWebhookSignature(
  body: Uint8Array,
  signature: string | null,
  secret: string,
): Promise<void> {
  if (signature === null || signature.length === 0) {
    throw new WebhookRejected(
      'SIGNATURE_MISSING',
      `the delivery carried no ${SIGNATURE_HEADER}`,
    );
  }
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    throw new WebhookRejected(
      'SIGNATURE_MALFORMED',
      `${SIGNATURE_HEADER} must be ${SIGNATURE_PREFIX}<hex>`,
    );
  }
  const presented = hexToBytes(signature.slice(SIGNATURE_PREFIX.length));
  if (presented === null) {
    throw new WebhookRejected(
      'SIGNATURE_MALFORMED',
      `${SIGNATURE_HEADER} is not hexadecimal`,
    );
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, body as BufferSource),
  );

  if (!equalBytes(expected, presented)) {
    throw new WebhookRejected(
      'SIGNATURE_MISMATCH',
      'the delivery signature does not match this installation’s secret',
    );
  }
}

interface DeliveryBody {
  action?: string;
  ref?: string;
  after?: string;
  repository?: { full_name?: string; default_branch?: string };
  installation?: { id?: number | string };
  repositories_removed?: { full_name?: string }[];
  repositories_added?: { full_name?: string }[];
}

function installationIdOf(body: DeliveryBody): string | null {
  const id = body.installation?.id;
  return id === undefined ? null : String(id);
}

function namesOf(
  entries: { full_name?: string }[] | undefined,
): readonly string[] {
  return (entries ?? [])
    .map((entry) => entry.full_name)
    .filter((name): name is string => name !== undefined);
}

/** Trusts its input; {@link handleWebhookDelivery} verifies first. */
export function parseWebhookDelivery(
  event: string,
  body: unknown,
): WebhookDelivery {
  if (typeof body !== 'object' || body === null) {
    throw new WebhookRejected(
      'BODY_MALFORMED',
      'the delivery body is not an object',
    );
  }
  const delivery = body as DeliveryBody;
  const installationId = installationIdOf(delivery);

  if (event === 'push') {
    const repository = delivery.repository?.full_name;
    const defaultBranch = delivery.repository?.default_branch;
    if (
      repository === undefined ||
      defaultBranch === undefined ||
      delivery.ref === undefined ||
      delivery.after === undefined
    ) {
      throw new WebhookRejected(
        'BODY_MALFORMED',
        'the push delivery named no repository, ref, or head commit',
      );
    }
    return {
      kind: 'push',
      repository,
      ref: delivery.ref,
      defaultBranch,
      head: delivery.after,
    };
  }

  if (installationId === null) {
    return { kind: 'ignored', reason: `${event} names no installation` };
  }

  if (event === 'installation') {
    switch (delivery.action) {
      case 'deleted':
        return {
          kind: 'accessLost',
          installationId,
          repositories: [],
          detail: 'the GitHub App installation was deleted',
        };
      case 'suspend':
        return {
          kind: 'accessLost',
          installationId,
          repositories: [],
          detail: 'the GitHub App installation was suspended',
        };
      case 'unsuspend':
        return { kind: 'accessRestored', installationId, repositories: [] };
      default:
        return {
          kind: 'ignored',
          reason: `installation.${delivery.action ?? 'unknown'} changes no access`,
        };
    }
  }

  if (event === 'installation_repositories') {
    const removed = namesOf(delivery.repositories_removed);
    if (removed.length > 0) {
      return {
        kind: 'accessLost',
        installationId,
        repositories: removed,
        detail: 'the repository was removed from the GitHub App installation',
      };
    }
    const added = namesOf(delivery.repositories_added);
    if (added.length > 0) {
      return { kind: 'accessRestored', installationId, repositories: added };
    }
    return {
      kind: 'ignored',
      reason: 'the delivery added and removed no repository',
    };
  }

  return { kind: 'ignored', reason: `${event} is not subscribed to` };
}

export interface RawDelivery {
  readonly event: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
}

/** Verifies first, so the JSON parser never sees unauthenticated input. */
export async function handleWebhookDelivery(
  delivery: RawDelivery,
  secret: string,
): Promise<WebhookDelivery> {
  await verifyWebhookSignature(delivery.body, delivery.signature, secret);

  if (delivery.event === null || delivery.event.length === 0) {
    throw new WebhookRejected(
      'EVENT_MISSING',
      `the delivery carried no ${EVENT_HEADER}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(delivery.body));
  } catch (cause) {
    throw new WebhookRejected(
      'BODY_MALFORMED',
      `the delivery body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseWebhookDelivery(delivery.event, body);
}
