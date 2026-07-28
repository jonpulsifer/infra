/**
 * The signed repository webhook (§15, §21).
 *
 * §21 names this one of the only externally reachable endpoints, and §15 pairs
 * it with periodic default-branch reconciliation so "a missed delivery
 * self-heals". Those two sentences set the whole posture of this module:
 *
 * - **The signature is the authentication, so it is checked before anything is
 *   parsed.** The body is untrusted bytes until the HMAC matches; parsing first
 *   would run a JSON decoder on whatever the internet sent.
 * - **A delivery is a hint, never a fact.** Nothing here writes. It classifies
 *   one delivery into {@link WebhookDelivery} and hands it to the repo loop,
 *   which does the same work whether it was woken by a delivery or by its own
 *   timer. That is what makes the loop the correctness path and this the
 *   latency optimization — the same shape the deploy loop takes with
 *   `LISTEN`/`NOTIFY`.
 * - **Everything unrecognized is `ignored`, with a reason.** A repository host
 *   sends events nobody subscribed to and adds new ones over time; a parser
 *   that threw on those would turn a product decision made elsewhere into a
 *   `500` on this installation's public endpoint.
 */

/** The header carrying the HMAC over the raw body. */
export const SIGNATURE_HEADER = 'X-Hub-Signature-256';
/** The header naming which event was delivered. */
export const EVENT_HEADER = 'X-GitHub-Event';

/**
 * What one delivery means to Spindrift.
 *
 * Three kinds and a fourth that means nothing, chosen because §15 gives exactly
 * three things a delivery can tell this system: the default branch moved,
 * access went away, or access came back.
 */
export type WebhookDelivery =
  | {
      /** A push to some ref. Whether it is *the* ref is the loop's question. */
      readonly kind: 'push';
      /** `owner/name`. */
      readonly repository: string;
      /** The full ref, e.g. `refs/heads/main`. */
      readonly ref: string;
      /** The repository's default branch as the delivery reported it. */
      readonly defaultBranch: string;
      /** The commit the ref now points at. */
      readonly head: string;
    }
  | {
      /**
       * The App lost access to one or more repositories: the installation was
       * deleted or suspended, or repositories were removed from a
       * selected-repository App.
       */
      readonly kind: 'accessLost';
      readonly installationId: string;
      /**
       * The repositories named by the delivery. Empty means *every* repository
       * of that installation, which is what a deletion or suspension is — the
       * delivery names an installation, not a list.
       */
      readonly repositories: readonly string[];
      /** The sentence an operator reads on the frozen repository. */
      readonly detail: string;
    }
  | {
      /** Access came back: an unsuspend, or repositories added. */
      readonly kind: 'accessRestored';
      readonly installationId: string;
      /** Empty means every repository of that installation. */
      readonly repositories: readonly string[];
    }
  | {
      readonly kind: 'ignored';
      /** Why nothing was derived from it, for a log line. */
      readonly reason: string;
    };

/** Why a delivery was refused before it was parsed. */
export type WebhookRejectionCode =
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_MISMATCH'
  | 'EVENT_MISSING'
  | 'BODY_MALFORMED';

/**
 * A delivery that will not be interpreted.
 *
 * Distinct from an `ignored` delivery, and the distinction is the security
 * boundary: `ignored` means "authenticated, and nothing to do"; this means "not
 * authenticated, or not a request at all". The endpoint answers `202` to the
 * first and `4xx` to the second, and conflating them would make an attacker's
 * unsigned body indistinguishable from a `ping`.
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
 * Compare two byte strings without leaking where they diverge.
 *
 * The length is compared first and separately, which does leak *that* — but the
 * length of a SHA-256 HMAC is a constant an attacker already knows, and the
 * alternative (padding to a fixed width) would compare bytes that mean nothing.
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
 * Check the HMAC over the **raw body bytes**.
 *
 * Bytes, not a string, and not a re-serialized object: the signature covers
 * exactly what was sent, and any round trip through a parser is a chance to
 * canonicalize a byte the sender did not. A caller that has already parsed the
 * body has already lost the ability to verify it.
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

/** The fields this module reads out of a delivery, all optional until checked. */
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

/**
 * Interpret one **already verified** delivery.
 *
 * Separate from verification so the ordering is visible at the call site rather
 * than trusted to a flag: {@link handleWebhookDelivery} is the composed form,
 * and this is what a test drives when it is asserting classification rather
 * than authentication.
 */
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

/** One raw delivery, exactly as it arrived. */
export interface RawDelivery {
  readonly event: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
}

/**
 * Verify, then interpret. The order is the whole contract.
 *
 * The body is decoded only after the HMAC over its bytes matched, so the JSON
 * parser never runs on unauthenticated input.
 */
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
