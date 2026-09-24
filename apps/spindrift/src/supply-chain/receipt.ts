/**
 * The signed source receipt: binds a bundle digest, which every build route
 * echoes, to its source and the principal that supplied it. Git and upload
 * share this one statement.
 */
import type { BuildProvenance } from '../adapters/build/contract.ts';

export type SourcePrincipal =
  | {
      readonly kind: 'githubApp';
      /** The GitHub App installation identity, not a short-lived token. */
      readonly subject: string;
    }
  | {
      readonly kind: 'user';
      /** The user id, not the mutable display name. */
      readonly subject: string;
    };

export type ReceiptSource =
  | {
      readonly kind: 'git';
      readonly repository: string;
      /** The exact revision returned by the fetcher. */
      readonly commit: string;
    }
  | {
      readonly kind: 'upload';
      /** An audit label only; the subject digest is the identity. */
      readonly name: string;
    };

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

export interface ReceiptSigner {
  sign(payload: Uint8Array): Promise<ReceiptSignature>;
}

/** Opaque to core: the signing service owns the algorithm and key id. */
export interface ReceiptSignature {
  readonly keyId: string;
  readonly algorithm: string;
  readonly value: string;
}

export interface SignedSourceReceipt {
  readonly statement: SourceReceiptStatement;
  readonly signature: ReceiptSignature;
}

/** Implementations key the object by the statement's subject digest. */
export interface SourceReceiptStore {
  putImmutable(
    receipt: SignedSourceReceipt,
  ): Promise<{ readonly location: string }>;
}

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
 * Rebuilds the statement field by field, so insertion order never changes the
 * signed bytes. A new signed field must be added here too.
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

/** Joins on the bundle digest alone, never on repository metadata. */
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
