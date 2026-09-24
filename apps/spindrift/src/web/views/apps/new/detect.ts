/**
 * What one repository read asks, and which detected directory the draft may
 * adopt. A reopened draft keeps its answers, and a read about one directory
 * never adopts another.
 */

import type { Draft, DraftAction } from '../../../../domain/creation-draft.ts';
import { serializeSpindriftFile } from '../../../../integrations/github/config-pr.ts';
import type { InputOf, OutputOf } from '../../../client.ts';

export type InspectedScope = OutputOf<'inspectRepository'>['scopes'][number];
export type DetectedScope = Extract<InspectedScope, { outcome: 'detected' }>;

/** A named directory is read alone, never searched for in a whole-tree read. */
export function inspection(
  fullName: string,
  scope?: string,
): InputOf<'inspectRepository'> {
  return scope === undefined ? { fullName } : { fullName, scopes: [scope] };
}

/**
 * The `spindrift.yaml` the configuration pull request commits for this scope,
 * from the commit's own serializer. Null when detection proposed nothing.
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

export function mergeScopes(
  current: readonly InspectedScope[],
  found: readonly InspectedScope[],
): readonly InspectedScope[] {
  const replaced = new Map(found.map((scope) => [scope.scope, scope] as const));
  const merged = current.map((scope) => replaced.get(scope.scope) ?? scope);
  const seen = new Set(current.map((scope) => scope.scope));
  return [...merged, ...found.filter((scope) => !seen.has(scope.scope))];
}

function soleDetected(scopes: readonly InspectedScope[]): DetectedScope | null {
  const detected = scopes.filter((scope) => scope.outcome === 'detected');
  return detected.length === 1 ? detected[0]! : null;
}

export type ReadOutcome =
  | { readonly act: 'detect'; readonly action: DraftAction }
  /** Several candidates, or an answered draft: the chooser shows the list. */
  | { readonly act: 'offer' }
  /** Nothing deployable in the directory asked about. */
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

/** Reads durable fields only, since session state resets on reopen. */
function answered(draft: Draft): boolean {
  return draft.scopeByOperator === true || draft.detection.scope !== undefined;
}

export function outcomeOf(
  draft: Draft,
  read: {
    readonly fullName: string;
    /** The directory this read asked about, or undefined for the repository. */
    readonly scope: string | undefined;
    readonly found: readonly InspectedScope[];
    /** Every scope known once this read is merged in. */
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

  // A whole-repository read never overrides an answered draft, as on reopen.
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
