/**
 * Confirms cloud facts from `discoverInstallationFacts` instead of typing them.
 * Each answer carries its manifest path, so the panel names no keys beyond the
 * two it narrows by.
 */
import { Check, CircleAlert, Search } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import type {
  DiscoveredCandidate,
  DiscoveredFact,
} from '../../../commands/installation/discover.ts';
import {
  HOME_VESSEL,
  placementOf,
} from '../../../commands/installation/discover.ts';
import { command } from '../../client.ts';
import { valueAt, withValueAt } from '../../forms/document.ts';
import { humanize } from '../../forms/schema.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';
import { cn } from '../../ui/utils.ts';

export type DiscoveryAnswer =
  | { readonly facts: readonly DiscoveredFact[] }
  | { readonly refusal: string };

/**
 * A transport failure becomes a refusal, since an empty answer would read as
 * a confirmed one.
 */
export async function askInstallationCloud(narrowing: {
  readonly project: string;
  readonly kmsLocation: string;
}): Promise<DiscoveryAnswer> {
  const project = narrowing.project.trim();
  const kmsLocation = narrowing.kmsLocation.trim();
  try {
    const result = await command('discoverInstallationFacts', {
      // Omitted when empty: with no project, the command lists projects.
      ...(project === '' ? {} : { project }),
      ...(kmsLocation === '' ? {} : { kmsLocation }),
    });
    return result.ok
      ? { facts: result.value.facts }
      : { refusal: result.failure.message };
  } catch (cause) {
    return {
      refusal:
        cause instanceof Error
          ? cause.message
          : 'This installation could not be asked about its cloud.',
    };
  }
}

export function DiscoveryPanel({
  document,
  disabled = false,
  onChange,
}: {
  readonly document: unknown;
  readonly disabled?: boolean;
  onChange(document: unknown): void;
}) {
  // Seeded once, so a later edit never rewrites a box under the cursor.
  const seed = narrowingFrom(document);
  const [project, setProject] = useState(seed.project);
  const [kmsLocation, setKmsLocation] = useState(seed.kmsLocation);
  const [facts, setFacts] = useState<readonly DiscoveredFact[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const discover = async (narrowing: {
    project: string;
    kmsLocation: string;
  }) => {
    setBusy(true);
    const answer = await askInstallationCloud(narrowing);
    setFacts('facts' in answer ? answer.facts : null);
    setRefusal('refusal' in answer ? answer.refusal : null);
    setBusy(false);
  };

  /** Applying a project also asks again: buckets and signing keys need one. */
  const apply = (fact: DiscoveredFact, candidate: DiscoveredCandidate) => {
    onChange(applyDiscovered(document, fact, candidate));
    if (!isProjectFact(fact) || typeof candidate.value !== 'string') return;
    setProject(candidate.value);
    void discover({ project: candidate.value, kmsLocation });
  };

  return (
    <Card>
      <CardHeader>
        <Search aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <CardTitle>What this installation's cloud says</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Read with the credential this deployment already mounts. Nothing is
            written until a value is applied below and the manifest is saved.
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Its own form, so Enter in a narrowing box asks. */}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void discover({ project, kmsLocation });
          }}
        >
          <div className="flex flex-col gap-4 sm:flex-row">
            <Field
              name="discovery.project"
              label="Project"
              hint="Leave empty to list the projects this identity can see."
              value={project}
              disabled={disabled || busy}
              onChange={(event) => setProject(event.target.value)}
            />
            <Field
              name="discovery.kmsLocation"
              label="Key location"
              hint="Signing keys are listed one location at a time."
              value={kmsLocation}
              disabled={disabled || busy}
              onChange={(event) => setKmsLocation(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="outline" disabled={disabled || busy}>
              <Search aria-hidden="true" />
              {busy ? 'Asking…' : 'Ask this installation’s cloud'}
            </Button>
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {busy
                ? 'Asking this installation’s cloud…'
                : facts === null
                  ? ''
                  : `${facts.length} ${facts.length === 1 ? 'value' : 'values'} came back.`}
            </p>
          </div>
        </form>
        {refusal === null ? null : <DiscoveryRefusal reason={refusal} />}
        {/* A grid row going from 0fr to 1fr animates to the content's height.
            It renders in every state, so the transition has a start. */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out',
            facts === null ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
        >
          <div className="overflow-hidden">
            {facts === null ? null : (
              <DiscoveredFactList
                facts={facts}
                document={document}
                disabled={disabled || busy}
                unwritable={(fact) => unwritable(fact, document)}
                onApply={apply}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Whether this fact answers for the project the other two reads need first. */
function isProjectFact(fact: DiscoveredFact): boolean {
  return fact.path.slice(-2).join('.') === 'location.project';
}

/**
 * The project and key location the document already names. A path that
 * resolves to nothing gives an empty string, which is the first-pass ask.
 */
export function narrowingFrom(document: unknown): {
  readonly project: string;
  readonly kmsLocation: string;
} {
  const at = placementOf(
    { path: ['vessels', HOME_VESSEL, 'location', 'project'], ...NO_ANSWER },
    document,
  );
  const project = at === null ? undefined : valueAt(document, at);
  // The key location is a segment of the signer URI, not a key of its own.
  const signer = valueAt(document, ['supplyChain', 'signer']);
  const location =
    typeof signer === 'string'
      ? /\/locations\/([^/]+)/.exec(signer)?.[1]
      : null;
  return {
    project: typeof project === 'string' ? project : '',
    kmsLocation: location ?? '',
  };
}

/** The `Discovered` half of a fact used only to address a path. */
const NO_ANSWER = { kind: 'found', candidates: [], suggested: null } as const;

/**
 * The ask failed. No value typed in the form fixes that, so it is not shown
 * as a field error.
 */
export function DiscoveryRefusal({ reason }: { readonly reason: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
      <div>
        <p className="font-medium">Nothing could be discovered.</p>
        <p className="mt-0.5">{reason}</p>
        <p className="mt-1 text-muted-foreground">
          This is a fact about the installation, not a field to correct.
        </p>
      </div>
    </div>
  );
}

/** Writes the candidate at the path the command gave; no key is named here. */
export function applyDiscovered(
  document: unknown,
  fact: DiscoveredFact,
  candidate: DiscoveredCandidate,
): unknown {
  const at = placementOf(fact, document);
  // No placement leaves the document alone: an entry removed since the ask
  // would make the old position address a different boundary.
  if (at === null) return document;
  return withValueAt(document, at, candidate.value);
}

/**
 * Why a confirmed value has nowhere to go, or `null`. The reason replaces the
 * candidates, since greyed buttons read as a cloud that answered nothing.
 */
export function unwritable(
  fact: DiscoveredFact,
  document: unknown,
): string | null {
  return placementOf(fact, document) === null
    ? 'the vessel this answers for is not declared in the document below'
    : null;
}

/**
 * One row per manifest path. Without `document`, a row lists candidates but
 * cannot say which one the document holds.
 */
export function DiscoveredFactList({
  facts,
  document,
  disabled = false,
  unwritable,
  onApply,
}: {
  readonly facts: readonly DiscoveredFact[];
  readonly document?: unknown;
  readonly disabled?: boolean;
  /** Omitted means every fact is writable. */
  unwritable?(fact: DiscoveredFact): string | null;
  onApply(fact: DiscoveredFact, candidate: DiscoveredCandidate): void;
}) {
  return (
    <dl className="flex flex-col gap-3">
      {facts.map((fact, index) => {
        const at = document === undefined ? null : placementOf(fact, document);
        const current = at === null ? undefined : valueAt(document, at);
        const applied =
          fact.kind === 'found'
            ? fact.candidates.find((candidate) => holds(current, candidate))
            : undefined;
        return (
          <div
            key={fact.path.join('.')}
            // `--i` carries the index, since CSS cannot count siblings. An
            // unavailable row is a dead end, so it renders still.
            style={
              fact.kind === 'unavailable'
                ? undefined
                : ({
                    '--i': index,
                    animationDelay: 'calc(var(--i) * 60ms)',
                  } as CSSProperties)
            }
            className={cn(
              'flex flex-col gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0',
              fact.kind !== 'unavailable' && 'motion-safe:animate-rise',
            )}
          >
            <dt className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-caption font-semibold uppercase tracking-eyebrow text-muted-foreground">
                {humanize(String(fact.path[fact.path.length - 1] ?? ''))}
              </span>
              {/* The full path too, since two keys can share a last segment. */}
              <code className="font-mono text-micro text-subtle">
                {fact.path.join('.')}
              </code>
              {current === undefined ? null : applied === undefined ? (
                <Badge tone="warning">stand-in</Badge>
              ) : (
                <Badge tone="success">confirmed</Badge>
              )}
            </dt>
            {current === undefined ? null : (
              <p className="font-mono text-xs text-muted-foreground">
                now: {readable(current)}
              </p>
            )}
            <dd className="text-sm">
              {fact.kind === 'unavailable' ? (
                <span className="text-muted-foreground">{fact.reason}</span>
              ) : unwritable?.(fact) ? (
                <span className="text-muted-foreground">
                  {unwritable(fact)}
                </span>
              ) : fact.candidates.length === 0 ? (
                <span className="text-muted-foreground">
                  Nothing of this kind exists here.
                </span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {fact.candidates.map((candidate) => (
                    <Button
                      key={candidate.label}
                      type="button"
                      size="sm"
                      // Marks what the document holds; `suggested` never changes on a press.
                      variant={candidate === applied ? 'default' : 'outline'}
                      aria-pressed={candidate === applied}
                      disabled={disabled}
                      onClick={() => onApply(fact, candidate)}
                    >
                      {candidate === applied ? (
                        <Check aria-hidden="true" />
                      ) : null}
                      {candidate.label}
                    </Button>
                  ))}
                </div>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Compares serialized values, since a list-valued key never passes `===`. */
function holds(current: unknown, candidate: DiscoveredCandidate): boolean {
  return JSON.stringify(current) === JSON.stringify(candidate.value);
}

/** A manifest value as one line of text. */
function readable(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
