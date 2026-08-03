/**
 * Confirming cloud facts instead of typing them (§13, §20, ticket 32 slice 2).
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
 * the panel keeps working as ticket 33 removes keys from the schema, and a
 * value it cannot place is not a value it can silently misplace.
 *
 * **A refusal reads as a fact, not as a field error.** That is the third of the
 * three refusals `installation.tsx` keeps apart: `unavailable` means the cloud
 * did not answer, which is nothing an operator can fix by re-typing a value in
 * this form. It renders in the neutral voice, beside the field it could not
 * answer, with the sentence the command produced — never as a blank, because a
 * blank on a confirmation screen reads as a confirmed answer.
 */
import { CircleAlert, Search } from 'lucide-react';
import { useState } from 'react';
import type {
  DiscoveredCandidate,
  DiscoveredFact,
} from '../../../commands/installation/discover.ts';
import { command } from '../../client.ts';
import { withValueAt } from '../../forms/document.ts';
import { humanize } from '../../forms/schema.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';

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
  const [project, setProject] = useState('');
  const [kmsLocation, setKmsLocation] = useState('');
  const [facts, setFacts] = useState<readonly DiscoveredFact[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const discover = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await command('discoverInstallationFacts', {
        // Absent rather than empty: the command's input is `.strict()` and an
        // empty project is not a project, it is the first pass.
        ...(project.trim() === '' ? {} : { project: project.trim() }),
        ...(kmsLocation.trim() === ''
          ? {}
          : { kmsLocation: kmsLocation.trim() }),
      });
      if (result.ok) {
        setFacts(result.value.facts);
      } else {
        setFacts(null);
        setRefusal(result.failure.message);
      }
    } catch (cause) {
      setFacts(null);
      setRefusal(
        cause instanceof Error
          ? cause.message
          : 'This installation could not be asked about its cloud.',
      );
    } finally {
      setBusy(false);
    }
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
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void discover()}
          >
            <Search aria-hidden="true" />
            {busy ? 'Asking…' : 'Ask this installation’s cloud'}
          </Button>
        </div>
        {refusal === null ? null : (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 text-subtle"
            />
            <div>
              <p className="font-medium">Nothing could be discovered.</p>
              <p className="mt-0.5">{refusal}</p>
              <p className="mt-1 text-muted-foreground">
                This is a fact about the installation, not a field to correct.
              </p>
            </div>
          </div>
        )}
        {facts === null ? null : (
          <DiscoveredFactList
            facts={facts}
            disabled={disabled || busy}
            onApply={(fact, candidate) =>
              onChange(applyDiscovered(document, fact, candidate))
            }
          />
        )}
      </CardContent>
    </Card>
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
  return withValueAt(document, fact.path, candidate.value);
}

/**
 * What came back, one row per manifest path.
 *
 * Pure, and exported, because this is the half with a claim in it: the two arms
 * have to read as two different things, and that is a statement about markup
 * rather than about a request.
 */
export function DiscoveredFactList({
  facts,
  disabled = false,
  onApply,
}: {
  readonly facts: readonly DiscoveredFact[];
  readonly disabled?: boolean;
  onApply(fact: DiscoveredFact, candidate: DiscoveredCandidate): void;
}) {
  return (
    <dl className="flex flex-col gap-3">
      {facts.map((fact) => (
        <div
          key={fact.path.join('.')}
          className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
        >
          <dt className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {/* The last segment, humanized. Never a key written here — the
                path came from the command, and the schema owns which keys
                exist. */}
            {humanize(fact.path[fact.path.length - 1] ?? '')}
          </dt>
          <dd className="text-sm">
            {fact.kind === 'unavailable' ? (
              <span className="text-muted-foreground">{fact.reason}</span>
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
                    variant={
                      candidate.label === fact.suggested?.label
                        ? 'default'
                        : 'outline'
                    }
                    disabled={disabled}
                    onClick={() => onApply(fact, candidate)}
                  >
                    {candidate.label}
                  </Button>
                ))}
              </div>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
