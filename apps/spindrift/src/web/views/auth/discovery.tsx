/**
 * Confirming cloud facts instead of typing them (§13, §20).
 *
 * The settings form below this panel can already edit every manifest key. What
 * it cannot do is tell an operator what the right value *is* — so a project id
 * or a signer URI is typed from memory, and a typo is invisible until a build
 * dies on a signed URL. `discoverInstallationFacts` asks the cloud with the
 * credential the pod already holds; this is the hand that reaches it and the
 * screen that shows what came back.
 *
 * **Nothing here names a manifest key**, which is the same correctness
 * requirement `installation.tsx` states for the form itself. Every answer
 * carries its own `path`, the panel titles it with {@link humanize} of the last
 * segment, and applying a candidate is {@link withValueAt} at that path — so
 * the panel keeps working as keys leave the schema, and a value it cannot place
 * is not a value it can silently misplace.
 *
 * **A refusal reads as a fact, not as a field error.** That is the third of the
 * three refusals `installation.tsx` keeps apart: `unavailable` means the cloud
 * did not answer, which is nothing an operator can fix by re-typing a value in
 * this form. It renders in the neutral voice, beside the field it could not
 * answer, with the sentence the command produced — never as a blank, because a
 * blank on a confirmation screen reads as a confirmed answer.
 *
 * **Every row is a reconciliation, not a row of buttons.** The panel shipped
 * deriving each candidate's selected style from `fact.suggested` — a property
 * of the *server's* answer, identical before and after a press — so confirming
 * a value changed the document and changed nothing on screen. What a row says
 * now is a comparison: the value the document holds at
 * {@link placementOf}, and which candidate, if any, is that value. A press is
 * visible because the document is what is being read.
 *
 * **It seeds the two narrowing inputs from the document, and that is the one
 * place it names keys.** Discovery is staged on purpose — with no project the
 * command answers "name a project and run discovery again" for buckets and
 * signing keys — and the candidate that unblocks it reads
 * `"<project> — this deployment's own credential"`, so an operator who types
 * what they read types a project that does not exist. Two paths are named to
 * close that: the home vessel's project, and the location inside the signer
 * this installation already holds. Both are paths the command itself answers
 * for, so a key that leaves the schema leaves the seed empty rather than
 * leaving a control writing somewhere nothing reads.
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

/** One ask, in the two arms every answer on this path comes back in. */
export type DiscoveryAnswer =
  | { readonly facts: readonly DiscoveredFact[] }
  | { readonly refusal: string };

/**
 * The request the panel makes, and the fold of everything it can come back as.
 *
 * Named and exported rather than living inside the click handler, for the
 * reason {@link applyDiscovered} is: the two things worth asserting here are
 * **which narrowing arguments are sent** and **that no way of failing turns
 * into an empty answer**, and neither needs a browser to observe. The panel
 * around it is then a shell that puts the result in state.
 *
 * Three ways of coming back, one shape: a result, a refusal the server gave,
 * and a `fetch` or a non-JSON body that never reached the command layer at all.
 * The last one throws out of `command`, and swallowing it into `facts: []`
 * would put a blank on a confirmation screen that reads as a confirmed answer.
 */
export async function askInstallationCloud(narrowing: {
  readonly project: string;
  readonly kmsLocation: string;
}): Promise<DiscoveryAnswer> {
  const project = narrowing.project.trim();
  const kmsLocation = narrowing.kmsLocation.trim();
  try {
    const result = await command('discoverInstallationFacts', {
      // Absent rather than empty: the command's input is `.strict()` and an
      // empty project is not a project, it is the first pass.
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

/**
 * Ask the cloud, then apply what an operator confirms.
 *
 * Self-contained rather than lifted into `InstallationSettingsView`'s props:
 * everything it holds — the two narrowing inputs, the last answer, whether a
 * request is in flight — is its own, and the only thing it has to say to the
 * screen around it is the edited document, which is the same `onChange` every
 * control on the page already speaks.
 */
export function DiscoveryPanel({
  document,
  disabled = false,
  onChange,
}: {
  readonly document: unknown;
  readonly disabled?: boolean;
  onChange(document: unknown): void;
}) {
  // Seeded once, from the document this panel opened on. Later edits do not
  // move these: they are what the operator is *narrowing* by, and a text box
  // that rewrote itself under a cursor because a candidate landed elsewhere
  // would be a worse bug than the empty one this replaces.
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

  /**
   * Confirming a value, and — for the project — asking again with it.
   *
   * The second half is what makes the staging finishable in the place it was
   * staged. Buckets and signing keys are not read until a project is named, so
   * the press that names one is the press that should produce them; leaving the
   * operator to copy a label into a box was leaving them to copy the words
   * "this deployment's own credential" along with it.
   */
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
        {/* A real form, so Enter in either narrowing box asks — and its own
            form rather than the manifest's, which is why `installation.tsx`
            mounts this panel outside the form it saves with: Enter here used
            to submit the whole manifest. */}
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
            {/* The ask can take as long as three cloud APIs take, and a button
                label is not announced. This is. */}
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
        {facts === null ? null : (
          <DiscoveredFactList
            facts={facts}
            document={document}
            disabled={disabled || busy}
            unwritable={(fact) => unwritable(fact, document)}
            onApply={apply}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Whether this fact answers for the project the other two reads need first. */
function isProjectFact(fact: DiscoveredFact): boolean {
  return fact.path.slice(-2).join('.') === 'location.project';
}

/**
 * What this document already says about the two things discovery narrows by.
 *
 * Exported and pure because it is the whole of what the panel knows about the
 * schema, and the one claim worth pinning without a browser: a document that
 * already names its project must arrive with that project in the box, or the
 * second stage of a two-stage ask is unreachable from the screen that staged
 * it. A path that resolves to nothing yields an empty string, which is exactly
 * the first-pass ask.
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
  // The location is not a manifest key of its own: it is a segment inside the
  // signer this installation already holds, and reading it back is cheaper for
  // an operator than finding the console page that lists it.
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
 * The whole ask having failed, in the neutral voice.
 *
 * Not a field error, and the markup says which: `role="alert"` beside a
 * sentence about the installation rather than an error class on an input. An
 * operator cannot fix an absent federation or a `403` by re-typing a value in
 * the form below, and telling them to would be the third of the three refusals
 * `installation.tsx` keeps apart, collapsed into the first.
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

/**
 * The document with one confirmed value in it.
 *
 * Named rather than inlined so it can be asserted without a browser: the whole
 * of what confirming does is put a value the command produced at a path the
 * command produced, and neither of those is this screen's to decide. A version
 * of this that reached for a key name would compile and would be the bug the
 * panel exists to avoid.
 */
export function applyDiscovered(
  document: unknown,
  fact: DiscoveredFact,
  candidate: DiscoveredCandidate,
): unknown {
  const at = placementOf(fact, document);
  // A document with nowhere to put this is left alone rather than written at
  // the position the answer was produced for: an entry removed between the ask
  // and the press would make that position address a different boundary.
  if (at === null) return document;
  return withValueAt(document, at, candidate.value);
}

/**
 * Why a confirmed value would not land, or `null` when it would.
 *
 * One way of not landing: an answer about a vessel the document below does not
 * declare has nowhere to go, and the sentence says where to fix it. Offering a
 * value that cannot be written is the shape of button
 * `commands/targets/disconnect.ts` refuses to render — an act that cannot
 * happen, shown as one that can — so the reason takes the place of the
 * candidates rather than greying them, because a disabled button with no
 * sentence reads as a cloud that answered nothing.
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
 * What came back, one row per manifest path, against what the document holds.
 *
 * Pure, and exported, because this is the half with the claims in it: the arms
 * have to read as different things, and a press has to change something — both
 * statements about markup rather than about a request.
 *
 * `document` is optional and its absence is honest rather than defaulted: a
 * caller with no document has nothing to compare against, so the row shows the
 * candidates and says nothing about which one is in force. Passing a document
 * is what turns the row into a reconciliation.
 */
export function DiscoveredFactList({
  facts,
  document,
  disabled = false,
  unwritable,
  onApply,
}: {
  readonly facts: readonly DiscoveredFact[];
  /** The document being edited, for the value each row is reconciled against. */
  readonly document?: unknown;
  readonly disabled?: boolean;
  /** {@link unwritable}, threaded by the panel. Omitted answers everything writable. */
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
            // Rows arrive in the order the cloud answered for, one behind the
            // next, because five values appearing at once reads as a page
            // reloading rather than as an installation being read.
            //
            // **A refusal does not arrive**, and that is the whole of the
            // rule this file already keeps in words: an `unavailable` arm is
            // an API that is switched off, and animating it in would make a
            // dead end look like something still landing. It renders as it
            // always did, immediately and still.
            //
            // The delay is per row rather than per group so a stagger stays a
            // stagger when a group is one row long, and `--i` carries the
            // index because CSS cannot count siblings into a duration.
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
                {/* The last segment, humanized. Never a key written here — the
                    path came from the command, and the schema owns which keys
                    exist. */}
                {humanize(String(fact.path[fact.path.length - 1] ?? ''))}
              </span>
              {/* And the whole path beside it, because the tail alone is
                  ambiguous by construction: two of the five answers humanize
                  to the same word for two different keys. */}
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
                      // Applied, not suggested. The suggestion is the server's
                      // opinion and never changes; what an operator needs to
                      // see is which candidate the document is currently
                      // holding, which is the thing a press moves.
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

/**
 * Whether the document is already holding what this candidate would write.
 *
 * By value rather than by label: a candidate's `value` is what lands, and for
 * a list-valued key it is a list, so `===` would answer "no" to a value it
 * just wrote. Serialized because these are manifest scalars and short lists,
 * where a deep compare is the same three lines with more edge cases.
 */
function holds(current: unknown, candidate: DiscoveredCandidate): boolean {
  return JSON.stringify(current) === JSON.stringify(candidate.value);
}

/** A manifest value as one line of text. */
function readable(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
