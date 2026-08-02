/**
 * Finishing a Target's connection (§13).
 *
 * `connectTarget` has existed since Task 13 with no screen in front of it, so
 * every Target this installation has was declared in the manifest or created
 * by a test. This is the screen.
 *
 * Three things keep it short, and all three come out of §13 rather than out of
 * a preference for short forms:
 *
 * - **The adapter is not a question.** A pending connection is a manifest seed,
 *   and a seed names its adapter. Nothing here asks what kind of thing this is;
 *   it asks the two or three facts that seed did not carry.
 * - **A cloud project is one act.** Connecting `bluenose` registers both
 *   `bluenose-cloudrun` and `bluenose-static`. The form says so and asks once.
 * - **Connect always succeeds, so there is no test button.** A reachability
 *   gate would be a second opinion about health, and §13 has exactly one: the
 *   standing checklist, which this act runs a pass of on its way through. Press
 *   the button and read the checklist — that *is* the test, and unlike a
 *   preflight it keeps being true tomorrow.
 */
import { Layers, Server } from 'lucide-react';
import { useState } from 'react';
import type { InputOf } from '../../client.ts';
import type { TargetConnectionProposal } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Field, Label } from '../../ui/field.tsx';

type ConnectTargetInput = InputOf<'connectTarget'>;

/**
 * The `sourceRef` a Flux delivery needs, defaulted from the proposal.
 *
 * Split out because it is the one nested value on the form, and because an
 * `argo-application` delivery does not have one — a shape the discriminated
 * union in `connectTarget` already refuses, and which this mirrors rather than
 * restates.
 */
function fluxDelivery(
  namespace: string,
  sourceName: string,
  sourceNamespace: string,
) {
  return {
    flavour: 'flux-helmrelease' as const,
    namespace,
    sourceRef: { name: sourceName, namespace: sourceNamespace },
  };
}

export function ConnectTargetForm({
  kind,
  name,
  targets,
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  kind: 'kubernetes' | 'cloud';
  name: string;
  targets: readonly string[];
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  // Per-instance, so never proposed: see `TargetConnectionProposal`.
  const [apiServer, setApiServer] = useState('');
  const [project, setProject] = useState('');
  // Carried where a working Target of the same adapter taught us the value.
  const [namespace, setNamespace] = useState(proposal.namespace ?? '');
  const [sourceName, setSourceName] = useState(proposal.sourceRef?.name ?? '');
  const [sourceNamespace, setSourceNamespace] = useState(
    proposal.sourceRef?.namespace ?? '',
  );
  const [region, setRegion] = useState(proposal.region ?? '');
  const [runEndpoint, setRunEndpoint] = useState(proposal.runEndpoint ?? '');
  const [hostingEndpoint, setHostingEndpoint] = useState(
    proposal.hostingEndpoint ?? '',
  );

  const carried = proposal.carriedFrom;
  // ponytail: the form writes a Flux delivery and only that. Argo is a real
  // `connectTarget` shape with five more fields and nothing in this
  // installation uses it, so rather than render a branch nobody exercises the
  // screen refuses and points at the manifest, which can express both. Add the
  // branch when a second delivery flavour actually shows up.
  const unsupportedDelivery = proposal.deliveryFlavour === 'argo-application';
  const ready =
    kind === 'kubernetes'
      ? apiServer.trim() !== '' &&
        namespace.trim() !== '' &&
        sourceName.trim() !== '' &&
        sourceNamespace.trim() !== ''
      : project.trim() !== '' &&
        region.trim() !== '' &&
        runEndpoint.trim() !== '' &&
        hostingEndpoint.trim() !== '';

  const submit = () => {
    onConnect(
      kind === 'kubernetes'
        ? {
            kind: 'kubernetes',
            name,
            apiServer: apiServer.trim(),
            namespace: namespace.trim(),
            delivery: fluxDelivery(
              namespace.trim(),
              sourceName.trim(),
              sourceNamespace.trim(),
            ),
            ...(proposal.chartContract === undefined
              ? {}
              : { chartContract: proposal.chartContract }),
          }
        : {
            kind: 'cloud',
            name,
            project: project.trim(),
            region: region.trim(),
            runEndpoint: runEndpoint.trim(),
            hostingEndpoint: hostingEndpoint.trim(),
            ...(proposal.policyEndpoint === undefined
              ? {}
              : { policyEndpoint: proposal.policyEndpoint }),
          },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {kind === 'kubernetes' ? (
          <Server aria-hidden="true" className="size-4 text-muted-foreground" />
        ) : (
          <Layers aria-hidden="true" className="size-4 text-muted-foreground" />
        )}
        <span className="font-mono text-sm font-semibold">{name}</span>
        <Badge tone="idle">
          {kind === 'kubernetes' ? 'cluster' : 'cloud project'}
        </Badge>
        {carried !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">
            defaults carried from <span className="font-mono">{carried}</span>
          </span>
        ) : null}
      </div>

      {targets.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Registers{' '}
          {targets.map((target, index) => (
            <span key={target}>
              {index > 0 ? ' and ' : ''}
              <span className="font-mono">{target}</span>
            </span>
          ))}{' '}
          — one project, both of its Targets.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {kind === 'kubernetes' ? (
          <>
            <Field
              name="api-server"
              label="API server"
              value={apiServer}
              onChange={(event) => setApiServer(event.target.value)}
              placeholder="https://kubernetes.default.svc"
              hint="Not carried from another cluster — this one names this cluster."
            />
            <Field
              name="namespace"
              label="Namespace"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              hint="Where App workloads land. Spindrift never creates it."
            />
            <Field
              name="source-name"
              label="Flux GitRepository"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              hint="The source the App chart is fetched from."
            />
            <Field
              name="source-namespace"
              label="GitRepository namespace"
              value={sourceNamespace}
              onChange={(event) => setSourceNamespace(event.target.value)}
            />
          </>
        ) : (
          <>
            <Field
              name="project"
              label="Project"
              value={project}
              onChange={(event) => setProject(event.target.value)}
              hint="Not carried — a second project prefilled with the first one's id would read as correct."
            />
            <Field
              name="region"
              label="Region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            />
            <Field
              name="run-endpoint"
              label="Cloud Run API"
              value={runEndpoint}
              onChange={(event) => setRunEndpoint(event.target.value)}
            />
            <Field
              name="hosting-endpoint"
              label="Hosting API"
              value={hostingEndpoint}
              onChange={(event) => setHostingEndpoint(event.target.value)}
            />
          </>
        )}
      </div>

      {kind === 'kubernetes' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery">Delivery</Label>
          <p className="text-xs text-muted-foreground">
            Flux <span className="font-mono">HelmRelease</span>.
          </p>
        </div>
      ) : null}

      {unsupportedDelivery ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          The cluster this installation already runs delivers through Argo. This
          form writes a Flux delivery and would not match it — declare this
          Target's connection in the installation manifest instead.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!ready || connecting || unsupportedDelivery}
          onClick={submit}
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={connecting}>
          Cancel
        </Button>
        <p className="text-xs text-muted-foreground">
          Connecting always succeeds. What it finds shows up as the checklist
          below.
        </p>
      </div>
    </div>
  );
}
