/**
 * What one read of a repository asks, and what the draft may take from it.
 *
 * Separate from the screen because the interesting part is a decision rather
 * than a rendering: which of the directories that came back — if any — the
 * draft is allowed to adopt. Two mistakes live here whenever this is a few
 * lines inside an effect, and both are silent:
 *
 * - A read nobody asked for **re-deciding a draft somebody already answered**.
 *   Drafts are durable rows reachable by URL, so the read that fills in a fresh
 *   draft runs again on every reopen; applying its proposal the second time
 *   reverts the kind, the Component name and the directory the operator
 *   corrected, and the save that follows makes it permanent.
 * - A read **about one directory answering with another**. A settled root
 *   directory asks about the path it now names; falling back to some other
 *   candidate moves the path out from under the operator, and leaving the old
 *   sentence standing describes a directory nobody named.
 */

import type { Draft, DraftAction } from '../../../../domain/creation-draft.ts';
import { serializeSpindriftFile } from '../../../../integrations/github/config-pr.ts';
import type { InputOf, OutputOf } from '../../../client.ts';

/** One directory `inspectRepository` had something to say about. */
export type InspectedScope = OutputOf<'inspectRepository'>['scopes'][number];
export type DetectedScope = Extract<InspectedScope, { outcome: 'detected' }>;

/**
 * The read to issue: the whole repository, or the one directory named.
 *
 * §5's "named, never searched" is a property of the request, not of the
 * rendering — a subpath edit that re-read the whole tree would answer about
 * directories the operator did not ask about and leave the named one to be
 * found among them.
 */
export function inspection(
  fullName: string,
  scope?: string,
): InputOf<'inspectRepository'> {
  return scope === undefined ? { fullName } : { fullName, scopes: [scope] };
}

/**
 * The `spindrift.yaml` this scope will get, as the writer would write it.
 *
 * Deploy is where a repository GitHub merely grants gets connected, and
 * connecting commits one of these per scope in the configuration pull request
 * (§15). Rendering it here is the difference between an operator agreeing to
 * "Deploy" and agreeing to a file landing in their repository — and it goes
 * through `serializeSpindriftFile`, the same emitter the commit uses, because a
 * preview composed by a second copy of the writer is a preview that drifts from
 * it.
 *
 * `null` for a scope detection could make nothing of: there is no proposal, so
 * there is no file, and §5's assertion path writes one only once the operator
 * has said what it should contain.
 */
export function spindriftFileFor(
  scope: InspectedScope | undefined,
): string | null {
  if (scope === undefined || scope.outcome !== 'detected') return null;
  return serializeSpindriftFile({
    kind: scope.kind,
    build:
      scope.frontend === 'dockerfile'
        ? {
            frontend: 'dockerfile',
            dockerfile: scope.dockerfile ?? 'Dockerfile',
          }
        : {
            frontend: 'railpack',
            buildCommand: scope.buildCommand,
            outputDirectory: scope.outputDirectory,
          },
    watchPaths: scope.watchPaths,
  });
}

/** A fresh answer about one directory, in place, with the rest left alone. */
export function mergeScopes(
  current: readonly InspectedScope[],
  found: readonly InspectedScope[],
): readonly InspectedScope[] {
  const replaced = new Map(found.map((scope) => [scope.scope, scope] as const));
  const merged = current.map((scope) => replaced.get(scope.scope) ?? scope);
  const seen = new Set(current.map((scope) => scope.scope));
  return [...merged, ...found.filter((scope) => !seen.has(scope.scope))];
}

/**
 * The one candidate, or nothing.
 *
 * §5's discovery is "a list for a human to choose from", and one entry is the
 * case where choosing is not a decision anybody makes differently. Two is.
 */
function soleDetected(scopes: readonly InspectedScope[]): DetectedScope | null {
  const detected = scopes.filter((scope) => scope.outcome === 'detected');
  return detected.length === 1 ? detected[0]! : null;
}

/** What the screen does with what came back. */
export type ReadOutcome =
  /** Detection proposed something the draft can take. */
  | { readonly act: 'detect'; readonly action: DraftAction }
  /** The list is the answer — the chooser below states it better than a sentence. */
  | { readonly act: 'offer' }
  /** Nothing here is deployable, said about the directory that was asked about. */
  | { readonly act: 'refuse'; readonly message: string };

function detected(scope: DetectedScope): ReadOutcome {
  return {
    act: 'detect',
    action: {
      type: 'detect',
      scope: scope.scope,
      kind: scope.kind,
      reason: scope.reason,
      unavailable: scope.unavailable,
    },
  };
}

/**
 * Whether anything on this draft is already an answer about what to deploy.
 *
 * Both halves are durable, which is the point: session state resets on the
 * reopen this guard exists for.
 */
function answered(draft: Draft): boolean {
  return draft.scopeByOperator === true || draft.detection.scope !== undefined;
}

export function outcomeOf(
  draft: Draft,
  read: {
    readonly fullName: string;
    /** The directory this read asked about, or undefined for the repository. */
    readonly scope: string | undefined;
    /** What came back from this read. */
    readonly found: readonly InspectedScope[];
    /** Everything known about the repository once this read is folded in. */
    readonly merged: readonly InspectedScope[];
  },
): ReadOutcome {
  if (read.scope !== undefined) {
    const named = read.found.find((scope) => scope.scope === read.scope);
    if (named?.outcome === 'detected') return detected(named);
    return {
      act: 'refuse',
      message:
        named?.outcome === 'unsupported'
          ? `Spindrift does not know how to build ${read.scope} in ${read.fullName}: ${named.detail} Name another directory, or pick the kind yourself.`
          : `Spindrift read nothing about ${read.scope} in ${read.fullName}. Name another directory, or pick the kind yourself.`,
    };
  }

  // A whole-repository read fills in a draft nobody has answered, and only
  // that. Reopening a draft is not a correction of it.
  if (answered(draft)) return { act: 'offer' };

  const named = read.found.find(
    (scope) => scope.scope === draft.source.subpath,
  );
  if (named?.outcome === 'detected') return detected(named);
  const sole = soleDetected(read.merged);
  if (sole !== null) return detected(sole);
  if (read.merged.some((scope) => scope.outcome === 'detected'))
    return { act: 'offer' };
  return {
    act: 'refuse',
    message:
      named?.outcome === 'unsupported'
        ? `Spindrift does not know how to build ${named.scope} in ${read.fullName}: ${named.detail} Name another directory, or pick the kind yourself.`
        : `Spindrift found nothing it knows how to build in ${read.fullName}. Every directory it read is listed below with what it found instead — name one yourself and pick the kind, or add a spindrift.yaml.`,
  };
}
