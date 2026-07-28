/**
 * The signed source receipt (§16).
 *
 * A build backend can prove what it did with a staged bundle, but only
 * Spindrift saw where that bundle came from. This statement closes that gap:
 * its subject is the content digest every build route must echo, and its
 * predicate names the source and the authenticated principal that supplied it.
 *
 * Git and upload deliberately share this one statement. They differ only in
 * the source and principal variants; neither gets a weaker custody path.
 */
import type { BuildProvenance } from '../adapters/build/contract.ts';

/** Who authenticated the act that supplied this bundle. */
export type SourcePrincipal =
  | {
      readonly kind: 'githubApp';
      /** Stable GitHub App installation identity, not a short-lived token. */
      readonly subject: string;
    }
  | {
      readonly kind: 'user';
      /** The enrolled Spindrift user id, not their mutable display name. */
      readonly subject: string;
    };

/** The origin Spindrift attests was staged. */
export type ReceiptSource =
  | {
      readonly kind: 'git';
      readonly repository: string;
      /** The exact revision returned by the fetcher. */
      readonly commit: string;
    }
  | {
      readonly kind: 'upload';
      /** An audit label only; identity is the digest in the statement subject. */
      readonly name: string;
    };

/**
 * One predicate for both source paths.
 *
 * The fixed field order is intentional. {@link sourceReceiptBytes} reconstructs
 * this shape before signing so callers cannot change the signed bytes merely by
 * constructing an equivalent object in a different insertion order.
 */
export interface SourceReceiptStatement {
  readonly version: 1;
  readonly subject: {
    readonly name: 'sourceBundle';
    /** `sha256:<hex>`, identical to `BuildSource.bundleDigest`. */
    readonly digest: string;
  };
  readonly predicate: {
    readonly source: ReceiptSource;
    readonly principal: SourcePrincipal;
    readonly stagedAt: string;
  };
}

/** What signs statements; Task 26 supplies the production implementation. */
export interface ReceiptSigner {
  sign(payload: Uint8Array): Promise<ReceiptSignature>;
}

/**
 * Opaque signature metadata returned by the signer.
 *
 * Core records it but does not invent an algorithm or key id. Those belong to
 * the configured signing service and rotate independently of this predicate.
 */
export interface ReceiptSignature {
  readonly keyId: string;
  readonly algorithm: string;
  readonly value: string;
}

export interface SignedSourceReceipt {
  readonly statement: SourceReceiptStatement;
  readonly signature: ReceiptSignature;
}

/**
 * Durable evidence storage.
 *
 * A receipt that exists only in the staging process closes no custody gap after
 * a restart. Implementations key the immutable object by
 * `receipt.statement.subject.digest`; returning its location lets the caller
 * retain a reference without duplicating the signed document in the database.
 */
export interface SourceReceiptStore {
  putImmutable(
    receipt: SignedSourceReceipt,
  ): Promise<{ readonly location: string }>;
}

/** Build one statement using the only field order the signer accepts. */
export function sourceReceiptStatement(input: {
  readonly bundleDigest: string;
  readonly source: ReceiptSource;
  readonly principal: SourcePrincipal;
  readonly stagedAt: Date;
}): SourceReceiptStatement {
  return {
    version: 1,
    subject: {
      name: 'sourceBundle',
      digest: input.bundleDigest,
    },
    predicate: {
      source: canonicalSource(input.source),
      principal: canonicalPrincipal(input.principal),
      stagedAt: input.stagedAt.toISOString(),
    },
  };
}

/**
 * Stable bytes for a source receipt signature.
 *
 * This is deliberately a narrow canonicalizer, not a generic canonical JSON
 * implementation: the statement is closed, shallow, and rebuilt field by
 * field. Adding a signed field therefore requires changing this function in
 * the same review as the type.
 */
export function sourceReceiptBytes(
  statement: SourceReceiptStatement,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: statement.version,
      subject: {
        name: statement.subject.name,
        digest: statement.subject.digest,
      },
      predicate: {
        source: canonicalSource(statement.predicate.source),
        principal: canonicalPrincipal(statement.predicate.principal),
        stagedAt: statement.predicate.stagedAt,
      },
    }),
  );
}

export async function signSourceReceipt(
  statement: SourceReceiptStatement,
  signer: ReceiptSigner,
): Promise<SignedSourceReceipt> {
  return {
    statement,
    signature: await signer.sign(sourceReceiptBytes(statement)),
  };
}

/**
 * §16's required correlation: the source receipt and backend provenance join
 * on the digest of the immutable bundle, with no inference from repo metadata.
 */
export function receiptJoinsProvenance(
  receipt: SignedSourceReceipt,
  provenance: BuildProvenance,
): boolean {
  return receipt.statement.subject.digest === provenance.bundleDigest;
}

function canonicalSource(source: ReceiptSource): ReceiptSource {
  return source.kind === 'git'
    ? {
        kind: 'git',
        repository: source.repository,
        commit: source.commit,
      }
    : { kind: 'upload', name: source.name };
}

function canonicalPrincipal(principal: SourcePrincipal): SourcePrincipal {
  return {
    kind: principal.kind,
    subject: principal.subject,
  };
}
