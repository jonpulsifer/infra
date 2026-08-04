/**
 * Connecting a Target (§13).
 *
 * The cluster half of this screen used to be eight text fields — an API server,
 * a namespace, a `GitRepository` and its namespace, and nothing at all for the
 * gateway, the authenticated edge, the config store, or the address a route's
 * DNS record points at, which meant a cluster connected here could never take
 * an App that had to be reachable. Every one of those is something the cluster
 * can be asked for, and asking a person to type them made connecting a Target a
 * form about how Kubernetes delivery works rather than a decision about where
 * to deploy.
 *
 * So it is the repository screen's shape, one noun over: **give an address,
 * read what is there, choose what to blend into, confirm.** `probeCluster` is
 * the read and it writes nothing; `connectTarget` is the confirm.
 *
 * What that buys, beyond fewer keystrokes:
 *
 * - **The components are the form.** A gateway, an authenticated edge, and a
 *   config store are each a card the operator includes or leaves out, and
 *   leaving one out is a supported Target rather than a half-filled one. §3's
 *   reaches fall out of what was included rather than being a fourth question.
 * - **Nothing is proposed that this cluster did not confirm.** A namespace, a
 *   chart source, and a gateway address come off the probe. What is carried
 *   from a working Target is only what `clusters/base` makes identical on every
 *   cluster, and the card says which of the two a value came from.
 * - **The declaration is on the screen.** What the button is about to do is
 *   rendered as the manifest entry that would do the same thing, because §13's
 *   connect act and the manifest's `targets[]` are one shape with two entry
 *   points — and an operator who cannot see that has to take it on faith.
 *
 * Connect still always succeeds, so there is still no test button. Press it and
 * read the checklist; that *is* the test, and unlike a preflight it keeps being
 * true tomorrow.
 */
import {
  AlertTriangle,
  Globe,
  Layers,
  Loader2,
  Lock,
  Radio,
  Search,
  Server,
  Shield,
  Waypoints,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  type ClusterConnectChoices,
  clusterConnectPlan,
  targetSeedOf,
  vesselSeedOf,
} from '../../../domain/target-onboarding.ts';
import type { VesselKind } from '../../../domain/vessel.ts';
import { command, type InputOf, type OutputOf } from '../../client.ts';
import type { TargetConnectionProposal } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { Field, Label } from '../../ui/field.tsx';
import { cn } from '../../ui/utils.ts';

type ConnectTargetInput = InputOf<'connectTarget'>;
type Probed = OutputOf<'probeCluster'>;

/** What the panel is doing, in the same three states the repository scan has. */
type Scan =
  | { readonly state: 'idle' }
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly probed: Probed }
  | { readonly state: 'failed'; readonly message: string };

export function ConnectTargetForm(props: {
  kind: VesselKind;
  name: string;
  /** True on the "add a Target" path, where no manifest seed named it. */
  nameEditable?: boolean;
  /**
   * The address to start from, which is only ever *this* Target's own.
   *
   * Empty on both connect paths, for the reason {@link TargetConnectionProposal}
   * gives for having no `apiServer` field: a cluster prefilled with another
   * cluster's address reads as correct and points somewhere else. Editing a
   * Target that is already connected is the one case where the address is not
   * somebody else's, and re-typing it to correct a gateway would be asking the
   * operator to restate the one fact the row is certain of.
   */
  apiServer?: string;
  targets: readonly string[];
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Heading {...props} />
      {props.kind === 'cluster' ? (
        <ConnectCluster {...props} />
      ) : (
        <ConnectCloud {...props} />
      )}
    </div>
  );
}

function Heading({
  kind,
  name,
  targets,
  proposal,
}: {
  kind: VesselKind;
  name: string;
  targets: readonly string[];
  proposal: TargetConnectionProposal;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {kind === 'cluster' ? (
          <Server aria-hidden="true" className="size-4 text-muted-foreground" />
        ) : (
          <Layers aria-hidden="true" className="size-4 text-muted-foreground" />
        )}
        <span className="font-mono text-sm font-semibold">{name}</span>
        <Badge tone="idle">
          {kind === 'cluster' ? 'cluster' : 'cloud project'}
        </Badge>
        {proposal.carriedFrom !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">
            defaults carried from{' '}
            <span className="font-mono">{proposal.carriedFrom}</span>
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
    </>
  );
}

// --- The cluster flow -------------------------------------------------------

function ConnectCluster({
  name,
  nameEditable = false,
  apiServer: knownApiServer = '',
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  name: string;
  nameEditable?: boolean;
  apiServer?: string;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [targetName, setTargetName] = useState(name);
  // Per-instance, so never proposed *from another Target*: this is the one field
  // that names *this* cluster, and a second cluster prefilled with the first
  // one's address would read as correct and deploy somewhere else. The caller
  // may still supply the row's own address, which is the same fact rather than
  // a proposal about it.
  const [apiServer, setApiServer] = useState(knownApiServer);
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  /** Counts reads, so a re-read remounts the panel below on the new answer. */
  const [reads, setReads] = useState(0);

  const read = async () => {
    setScan({ state: 'reading' });
    try {
      const result = await command('probeCluster', {
        apiServer: apiServer.trim(),
      });
      setReads((count) => count + 1);
      setScan(
        result.ok
          ? { state: 'read', probed: result.value }
          : { state: 'failed', message: result.failure.message },
      );
    } catch (cause) {
      setScan({
        state: 'failed',
        message:
          cause instanceof Error ? cause.message : 'Reading the cluster failed',
      });
    }
  };

  const addressed = targetName.trim() !== '' && apiServer.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {nameEditable ? (
          <Field
            name="target-name"
            label="Target name"
            value={targetName}
            onChange={(event) => setTargetName(event.target.value)}
            hint="What this Target is called here. Placement and rank use it."
          />
        ) : null}
        <Field
          name="api-server"
          label="API server"
          value={apiServer}
          onChange={(event) => {
            setApiServer(event.target.value);
            // The panel below is about the cluster that was read, so editing
            // the address retires it rather than leaving choices standing that
            // came from somewhere else.
            setScan({ state: 'idle' });
          }}
          placeholder="https://cluster.example:6443"
          hint="The only thing needed to read the cluster. Nothing is written."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={scan.state === 'read' ? 'outline' : 'default'}
          disabled={!addressed || scan.state === 'reading'}
          onClick={read}
        >
          {scan.state === 'reading' ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Search aria-hidden="true" className="size-4" />
          )}
          {scan.state === 'reading'
            ? 'Reading…'
            : scan.state === 'read'
              ? 'Read again'
              : 'Read this cluster'}
        </Button>
        {scan.state === 'idle' ? (
          <p className="text-xs text-muted-foreground">
            Spindrift asks the cluster what it runs, and offers what it finds.
          </p>
        ) : null}
        {scan.state === 'idle' || scan.state === 'failed' ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {scan.state === 'failed' ? (
        <Notice tone="destructive">
          The cluster could not be read: {scan.message}
        </Notice>
      ) : null}

      {scan.state === 'read' ? (
        <ClusterComponents
          key={reads}
          name={targetName.trim()}
          apiServer={apiServer.trim()}
          probed={scan.probed}
          proposal={proposal}
          connecting={connecting}
          onConnect={onConnect}
          onCancel={onCancel}
        />
      ) : null}
    </div>
  );
}

/**
 * The components this cluster offers, and the choice about each.
 *
 * Mounted fresh per read — the caller keys it on the read count — so re-reading
 * a cluster after fixing its RBAC re-derives every default rather than leaving
 * a stale pick that the new probe no longer offers.
 */
function ClusterComponents({
  name,
  apiServer,
  probed,
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  name: string;
  apiServer: string;
  probed: Probed;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const { probe } = probed;
  const carried = carriedPlatform(proposal);

  const namespaces = probe.namespaces;
  const [namespace, setNamespace] = useState(
    pick(namespaces, proposal.namespace),
  );
  const [deliveryNamespace, setDeliveryNamespace] = useState(
    pick(namespaces, proposal.namespace),
  );
  const [source, setSource] = useState(
    refKey(probe.chartSources, proposal.sourceRef),
  );
  const [gatewayName, setGatewayName] = useState(
    refKey(probe.gateways, undefined),
  );
  /**
   * Read off the Gateway, and still editable.
   *
   * Two states need it to be a field rather than a derived value, and both are
   * ordinary: a Gateway whose load balancer has not been assigned yet reports
   * no address, and a cluster that would not let its Gateways be listed offers
   * nothing to read one off. Either way the operator knows the address and the
   * alternative is a Target that can only reach `none`.
   */
  const [privateAddress, setPrivateAddress] = useState(
    probe.gateways[0]?.address ?? '',
  );
  const [gatewayOn, setGatewayOn] = useState(probe.gateways.length > 0);
  const [authOn, setAuthOn] = useState(carried.externalAuth !== null);
  const [authName, setAuthName] = useState(carried.externalAuth?.name ?? '');
  const [authNamespace, setAuthNamespace] = useState(
    carried.externalAuth?.namespace ?? '',
  );
  const [authPort, setAuthPort] = useState(
    String(carried.externalAuth?.port ?? 80),
  );
  const [storeOn, setStoreOn] = useState(probe.secretStores.length > 0);
  const [store, setStore] = useState(probe.secretStores[0] ?? '');
  const [tunnelOn, setTunnelOn] = useState(false);
  const [tunnel, setTunnel] = useState('');

  // Parsed rather than looked up, because {@link Choice} degrades to a text
  // field on a cluster that would not list the kind — and a form that could
  // only accept what the probe returned would be unusable on exactly the
  // cluster whose RBAC has not merged yet, which is every cluster once.
  const chosenGateway = parseRef(gatewayName);
  const chosenSource = parseRef(source);
  const discoveredAddress =
    probe.gateways.find((entry) => refOf(entry) === gatewayName)?.address ??
    null;

  const choices: ClusterConnectChoices = {
    name,
    apiServer,
    namespace,
    deliveryNamespace,
    sourceRef: chosenSource ?? { name: '', namespace: '' },
    gateway:
      gatewayOn && chosenGateway !== null
        ? {
            name: chosenGateway.name,
            namespace: chosenGateway.namespace,
            privateAddress:
              privateAddress.trim() === '' ? null : privateAddress.trim(),
          }
        : null,
    externalAuth:
      authOn && authName.trim() !== '' && authNamespace.trim() !== ''
        ? {
            name: authName.trim(),
            namespace: authNamespace.trim(),
            port: Number(authPort) || 80,
          }
        : null,
    secretStore: storeOn && store !== '' ? store : null,
    tunnelHostname: tunnelOn && tunnel.trim() !== '' ? tunnel.trim() : null,
  };
  const plan = clusterConnectPlan(choices);

  const servesFlux = probe.deliveryFlavours.includes('flux-helmrelease');
  const ready =
    name !== '' &&
    namespace !== '' &&
    deliveryNamespace !== '' &&
    chosenSource !== null;

  return (
    <div className="flex flex-col gap-3 border-t border-border-soft pt-4">
      {!servesFlux ? (
        <Notice tone="warning">
          This cluster serves no <span className="font-mono">HelmRelease</span>,
          so a Target here has nothing to deliver through. Connecting still
          records it — the checklist will say the same thing, and keep saying it
          until Flux is installed.
        </Notice>
      ) : null}

      <Component
        icon={<Waypoints aria-hidden="true" className="size-4" />}
        title="Delivery"
        because="Flux applies the App chart. Spindrift writes the HelmRelease through the API."
        required
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Choice
            name="delivery-namespace"
            label="HelmRelease namespace"
            value={deliveryNamespace}
            onChange={setDeliveryNamespace}
            options={namespaces}
            hint="Read off this cluster."
          />
          <Choice
            name="chart-source"
            label="Chart source"
            value={source}
            onChange={setSource}
            options={probe.chartSources.map(refOf)}
            hint={
              probe.chartSources.length === 0
                ? 'No GitRepository was readable here — the App chart has nowhere to come from.'
                : 'The GitRepository the App chart is fetched from.'
            }
          />
        </div>
      </Component>

      <Component
        icon={<Server aria-hidden="true" className="size-4" />}
        title="Workloads"
        because="Where an App's release lands. Spindrift never creates the namespace (§7)."
        required
      >
        <Choice
          name="workload-namespace"
          label="Namespace"
          value={namespace}
          onChange={setNamespace}
          options={namespaces}
        />
      </Component>

      <Component
        icon={<Radio aria-hidden="true" className="size-4" />}
        title="Gateway"
        because="Routes attach to it, and its address is where a private record points."
        on={gatewayOn}
        onToggle={setGatewayOn}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Choice
            name="gateway"
            label="Gateway"
            value={gatewayName}
            onChange={(value) => {
              setGatewayName(value);
              // Follow the pick. An address left behind from the previous
              // Gateway is the one wrong value here that would look right.
              setPrivateAddress(
                probe.gateways.find((entry) => refOf(entry) === value)
                  ?.address ?? '',
              );
            }}
            options={probe.gateways.map(refOf)}
            hint={
              probe.gateways.length === 0
                ? 'No Gateway was readable here — name one as namespace/name.'
                : undefined
            }
          />
          <Field
            name="private-address"
            label="Private address"
            value={privateAddress}
            onChange={(event) => setPrivateAddress(event.target.value)}
            hint={
              discoveredAddress === null
                ? 'This Gateway reports no address, so nothing was read — an empty field means this Target reaches only in-cluster.'
                : 'Read off the Gateway. Published unproxied, so it is the private boundary.'
            }
          />
        </div>
      </Component>

      <Component
        icon={<Shield aria-hidden="true" className="size-4" />}
        title="Authenticated edge"
        because="Stands in front of a Component whose auth is proxy."
        on={authOn}
        onToggle={setAuthOn}
        carriedFrom={
          carried.externalAuth === null ? null : proposal.carriedFrom
        }
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            name="auth-namespace"
            label="Namespace"
            value={authNamespace}
            onChange={(event) => setAuthNamespace(event.target.value)}
          />
          <Field
            name="auth-name"
            label="Service"
            value={authName}
            onChange={(event) => setAuthName(event.target.value)}
          />
          <Field
            name="auth-port"
            label="Port"
            value={authPort}
            onChange={(event) => setAuthPort(event.target.value)}
          />
        </div>
      </Component>

      <Component
        icon={<Lock aria-hidden="true" className="size-4" />}
        title="Config store"
        because="Where a Component's pinned secrets are fetched from (§10)."
        on={storeOn}
        onToggle={setStoreOn}
      >
        <Choice
          name="secret-store"
          label="ClusterSecretStore"
          value={store}
          onChange={setStore}
          options={probe.secretStores}
          hint={
            probe.secretStores.length === 0
              ? 'No ClusterSecretStore was readable here. Leaving this out is a Target that can run a Component with no config and refuse one with config, visibly.'
              : undefined
          }
        />
      </Component>

      <Component
        icon={<Globe aria-hidden="true" className="size-4" />}
        title="Public reach"
        because="A tunnel hostname is what makes a public record something other than a claim."
        on={tunnelOn}
        onToggle={setTunnelOn}
      >
        <Field
          name="tunnel-hostname"
          label="Tunnel hostname"
          value={tunnel}
          onChange={(event) => setTunnel(event.target.value)}
          hint="Not readable from the cluster — the tunnel is registered with the edge provider, not here."
        />
      </Component>

      <div className="rounded-md border border-border-soft bg-secondary/40 px-3 py-2 text-xs">
        <span className="text-muted-foreground">This Target will serve </span>
        {plan.reaches.map((reach) => (
          <Badge key={reach} tone="idle" className="mr-1">
            {reach}
          </Badge>
        ))}
        <span className="text-muted-foreground">
          {plan.authReaches.length === 0
            ? ', with no authenticated edge in front of any of it.'
            : `, authenticated at ${plan.authReaches.join(' and ')}.`}
        </span>
      </div>

      <Declaration plan={plan} />

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!ready || connecting} onClick={() => onConnect(plan)}>
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

/** What the button is about to do, as the manifest would declare it. */
function Declaration({
  plan,
}: {
  plan: ReturnType<typeof clusterConnectPlan>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        Declaration
        <span className="ml-auto font-mono">
          {open ? 'hide' : 'manifest entry'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
        <p className="text-[11px] text-subtle">
          The same connection, under <span className="font-mono">vessels:</span>{' '}
          and <span className="font-mono">targets:</span> in the installation
          manifest. A declaration seeds an installation that has none; it does
          not overwrite one that is already configured.
        </p>
        {/* Both arrays, because one connect act names a boundary and a surface
            on it. JSON, which is valid YAML — an emitter would be a thing to
            maintain for output nobody parses back. */}
        <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
          {JSON.stringify(
            { vessels: [vesselSeedOf(plan)], targets: [targetSeedOf(plan)] },
            null,
            2,
          )}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- The cloud flow, unchanged ---------------------------------------------

/**
 * A cloud project's two Targets, in one act (§13).
 *
 * Still a flat form, and not because nobody got to it: a project has no
 * discovery API to enumerate itself through before it is named, so there is
 * nothing here for a probe to read. The two endpoints and the region are
 * carried from a working cloud Target; the project id never is.
 */
function ConnectCloud({
  name,
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  name: string;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [project, setProject] = useState('');
  const [region, setRegion] = useState(proposal.region ?? '');
  const [runEndpoint, setRunEndpoint] = useState(proposal.runEndpoint ?? '');
  const [hostingEndpoint, setHostingEndpoint] = useState(
    proposal.hostingEndpoint ?? '',
  );

  const ready =
    project.trim() !== '' &&
    region.trim() !== '' &&
    runEndpoint.trim() !== '' &&
    hostingEndpoint.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
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
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!ready || connecting}
          onClick={() =>
            onConnect({
              kind: 'gcp-project',
              name,
              project: project.trim(),
              region: region.trim(),
              runEndpoint: runEndpoint.trim(),
              hostingEndpoint: hostingEndpoint.trim(),
              ...(proposal.policyEndpoint === undefined
                ? {}
                : { policyEndpoint: proposal.policyEndpoint }),
            })
          }
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={connecting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// --- atoms ------------------------------------------------------------------

/**
 * One thing a Target can blend into, and whether it is included.
 *
 * `required` and `on` are the two shapes: a required component has no toggle
 * because a Target without it is not addressable, and an optional one is a
 * checkbox whose off state is a supported Target rather than an incomplete
 * form.
 *
 * There is deliberately no disabled state. Nothing here is unavailable because
 * the probe did not find it — a cluster that would not list its Gateways still
 * has one, and greying the card out would make a cluster whose RBAC has not
 * merged yet unconnectable through the product. What the probe did not find
 * shows up as a field to type with the sentence saying nothing was read, which
 * is §3's grammar rather than a dead control.
 */
function Component({
  icon,
  title,
  because,
  required = false,
  on,
  onToggle,
  carriedFrom,
  children,
}: {
  icon: ReactNode;
  title: string;
  because: string;
  required?: boolean;
  on?: boolean;
  onToggle?: (on: boolean) => void;
  carriedFrom?: string | null;
  children: ReactNode;
}) {
  const included = required || on === true;
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-3',
        included ? 'border-border' : 'border-border-soft opacity-70',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        {required ? (
          <Badge tone="idle">required</Badge>
        ) : (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={on === true}
              onChange={(event) => onToggle?.(event.target.checked)}
            />
            include
          </label>
        )}
        {carriedFrom ? (
          <span className="text-[11px] text-subtle">
            carried from <span className="font-mono">{carriedFrom}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{because}</p>
      {included ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** A labelled pick from what the probe found, with a typed escape hatch. */
function Choice({
  name,
  label,
  value,
  onChange,
  options,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  hint?: string;
}) {
  // Nothing was readable, so there is nothing to pick from and the operator
  // types it. The same field either way — a disabled select would be a dead end
  // on a cluster whose RBAC is merged but not yet reconciled.
  if (options.length === 0) {
    return (
      <Field
        name={name}
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(hint === undefined ? {} : { hint })}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'warning' | 'destructive';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        tone === 'warning'
          ? 'border-warning/40 bg-warning-soft'
          : 'border-destructive/40 bg-destructive-soft text-destructive',
      )}
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** `namespace/name` — the one string a `<select>` can carry a ref in. */
function refOf(entry: { name: string; namespace: string }): string {
  return `${entry.namespace}/${entry.name}`;
}

/** A `namespace/name` back into a ref, or null when it is not one yet. */
function parseRef(value: string): { name: string; namespace: string } | null {
  const [namespace, name, ...rest] = value.split('/');
  if (rest.length > 0) return null;
  if (!namespace || !name) return null;
  return { namespace, name };
}

/** The preferred ref when this cluster has it, otherwise the first one. */
function refKey(
  entries: readonly { name: string; namespace: string }[],
  preferred: { name: string; namespace: string } | undefined,
): string {
  const match =
    preferred === undefined
      ? undefined
      : entries.find(
          (entry) =>
            entry.name === preferred.name &&
            entry.namespace === preferred.namespace,
        );
  const chosen = match ?? entries[0];
  return chosen === undefined ? '' : refOf(chosen);
}

/** The preferred option when this cluster has it, otherwise the first one. */
function pick(
  options: readonly string[],
  preferred: string | undefined,
): string {
  if (preferred !== undefined && options.includes(preferred)) return preferred;
  return options[0] ?? preferred ?? '';
}

/**
 * The parts of a working Target's chart-values worth carrying.
 *
 * Only `externalAuth`: `clusters/base` installs the authenticated edge in the
 * same namespace on every cluster, so the value a working Target holds is the
 * right proposal for the next one. `dns` and `gateway` are pointedly not here —
 * they name one cluster's address, and the probe read this one's.
 */
function carriedPlatform(proposal: TargetConnectionProposal): {
  externalAuth: { name: string; namespace: string; port: number } | null;
} {
  const platform = (
    proposal.chartValues as { platform?: Record<string, unknown> } | undefined
  )?.platform;
  const auth = platform?.externalAuth as
    | { name?: string; namespace?: string; port?: number }
    | undefined;
  if (auth?.name === undefined || auth.namespace === undefined) {
    return { externalAuth: null };
  }
  return {
    externalAuth: {
      name: auth.name,
      namespace: auth.namespace,
      port: auth.port ?? 80,
    },
  };
}
