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
import type {
  CloudBoundaryFacts,
  TargetConnectionProposal,
} from '../../../commands/views.ts';
import {
  KUBERNETES_DELIVERY_FLAVOURS,
  type KubernetesDelivery,
  type KubernetesDeliveryFlavour,
} from '../../../domain/target.ts';
import {
  type ClusterConnectChoices,
  clusterConnectPlan,
  targetSeedOf,
  vesselSeedOf,
} from '../../../domain/target-onboarding.ts';
import type { VesselKind } from '../../../domain/vessel.ts';
import { command, type InputOf, type OutputOf } from '../../client.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Declaration as SharedDeclaration } from '../../ui/declaration.tsx';
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
  /** The boundary being connected. Every surface on it is registered. */
  vessel: string;
  /** True on the "add a Vessel" path, where no manifest seed named it. */
  vesselEditable?: boolean;
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
  /** The same fact for a cloud boundary, on the same one path — an edit. */
  project?: string;
  /** And for an edge platform's boundary: the team this surface deploys into. */
  team?: string;
  /** And for a Cloudflare account: the account its projects are created under. */
  account?: string;
  /** What an edit of a cloud boundary restates so the act does not delete it. */
  carried?: CloudBoundaryFacts;
  /** The surfaces this one act probes that boundary for. */
  surfaces: readonly string[];
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Heading {...props} />
      {props.kind === 'cluster' ? <ConnectCluster {...props} /> : null}
      {props.kind === 'gcp-project' ? <ConnectCloud {...props} /> : null}
      {props.kind === 'vercel-team' ? <ConnectVercel {...props} /> : null}
      {props.kind === 'cloudflare-account' ? (
        <ConnectCloudflareAccount {...props} />
      ) : null}
    </div>
  );
}

/** What an operator calls the boundary they are connecting. */
const BOUNDARY_NOUN: Record<VesselKind, string> = {
  cluster: 'cluster',
  'gcp-project': 'cloud project',
  'vercel-team': 'Vercel team',
  'cloudflare-account': 'Cloudflare account',
};

function Heading({
  kind,
  vessel,
  surfaces,
  proposal,
}: {
  kind: VesselKind;
  vessel: string;
  surfaces: readonly string[];
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
        <span className="font-mono text-sm font-semibold">{vessel}</span>
        <Badge tone="idle">{BOUNDARY_NOUN[kind]}</Badge>
        {proposal.carriedFrom !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">
            defaults carried from{' '}
            <span className="font-mono">{proposal.carriedFrom}</span>
          </span>
        ) : null}
      </div>
      {surfaces.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Asks for{' '}
          {surfaces.map((surface, index) => (
            <span key={surface}>
              {index > 0 ? ' and ' : ''}
              <span className="font-mono">
                {vessel}/{surface}
              </span>
            </span>
          ))}{' '}
          — one project, and a Target for each one it finds.
        </p>
      ) : null}
    </>
  );
}

// --- The cluster flow -------------------------------------------------------

function ConnectCluster({
  vessel,
  vesselEditable = false,
  apiServer: knownApiServer = '',
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  vessel: string;
  vesselEditable?: boolean;
  apiServer?: string;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [vesselName, setVesselName] = useState(vessel);
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

  const addressed = vesselName.trim() !== '' && apiServer.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {vesselEditable ? (
          <Field
            name="vessel-name"
            label="Vessel name"
            value={vesselName}
            onChange={(event) => setVesselName(event.target.value)}
            hint="What this boundary is called here. Every surface on it is named for it."
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
          vessel={vesselName.trim()}
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
  vessel,
  apiServer,
  probed,
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  vessel: string;
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
  const [flavour, setFlavour] = useState<KubernetesDeliveryFlavour>(
    pickFlavour(probe.deliveryFlavours, proposal.deliveryFlavour),
  );
  // Argo's half. None of it is readable: `repoURL` and `targetRevision` are
  // where *this installation's* chart lives, which the cluster has no opinion
  // about, and a project is a name Argo would answer for only if it were asked
  // about one that already exists. So the two that have a conventional answer
  // start at it and the two that do not start empty and gate the button.
  const [project, setProject] = useState('default');
  const [repoUrl, setRepoUrl] = useState('');
  const [revision, setRevision] = useState('');
  const [server, setServer] = useState('https://kubernetes.default.svc');
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

  const delivery: KubernetesDelivery =
    flavour === 'argo-application'
      ? {
          flavour,
          namespace: deliveryNamespace,
          project: project.trim(),
          repoUrl: repoUrl.trim(),
          revision: revision.trim(),
          server: server.trim(),
        }
      : {
          flavour: 'flux-helmrelease',
          namespace: deliveryNamespace,
          sourceRef: chosenSource ?? { name: '', namespace: '' },
        };

  const choices: ClusterConnectChoices = {
    vessel,
    apiServer,
    namespace,
    delivery,
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

  const serves = probe.deliveryFlavours.includes(delivery.flavour);
  const kind =
    delivery.flavour === 'argo-application' ? 'Application' : 'HelmRelease';
  const ready =
    vessel !== '' &&
    namespace !== '' &&
    deliveryNamespace !== '' &&
    (delivery.flavour === 'argo-application'
      ? delivery.project !== '' &&
        delivery.repoUrl !== '' &&
        delivery.revision !== '' &&
        delivery.server !== ''
      : chosenSource !== null);

  return (
    <div className="flex flex-col gap-3 border-t border-border-soft pt-4">
      {!serves ? (
        <Notice tone="warning">
          This cluster serves no <span className="font-mono">{kind}</span>, so a
          Target delivered that way has nothing to deliver through. Connecting
          still records it — the checklist will say the same thing, and keep
          saying it until the operator is installed.
        </Notice>
      ) : null}

      <Component
        icon={<Waypoints aria-hidden="true" className="size-4" />}
        title="Delivery"
        because="The GitOps operator applies the App chart. Spindrift writes its object through the API — never manifests to a repository (§6)."
        required
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Choice
            name="delivery-flavour"
            label="Operator"
            value={delivery.flavour}
            onChange={(value) => setFlavour(value as KubernetesDeliveryFlavour)}
            // Both, always, and never only what the probe found: a cluster
            // whose Argo CRDs are applied but not yet established reads as
            // serving neither, and a picker offering neither is a cluster that
            // cannot be connected until somebody else's reconcile finishes.
            // What was read shows up as the notice above instead.
            options={[...KUBERNETES_DELIVERY_FLAVOURS]}
            hint={
              probe.deliveryFlavours.length === 0
                ? 'Neither operator was readable here. Pick the one this cluster will run.'
                : `Read off this cluster: ${probe.deliveryFlavours.join(', ')}.`
            }
          />
          <Choice
            name="delivery-namespace"
            label={`${kind} namespace`}
            value={deliveryNamespace}
            onChange={setDeliveryNamespace}
            options={namespaces}
            hint="Read off this cluster."
          />
          {delivery.flavour === 'argo-application' ? (
            <>
              <Field
                name="argo-project"
                label="Project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
                hint="The Argo project the Application belongs to."
              />
              <Field
                name="argo-server"
                label="Destination cluster"
                value={server}
                onChange={(event) => setServer(event.target.value)}
                hint="In Argo’s vocabulary. The in-cluster name, because the Application is created in the cluster it deploys to."
              />
              <Field
                name="argo-repo-url"
                label="Chart repository"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                hint="Where the App chart is fetched from. Argo resolves it with credentials Spindrift never sees, so nothing here was read."
              />
              <Field
                name="argo-revision"
                label="Revision"
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                hint="The branch, tag, or version the chart is taken at."
              />
            </>
          ) : (
            <Choice
              name="chart-source"
              label="Chart source"
              value={source}
              onChange={setSource}
              options={probe.chartSources.map(refOf)}
              hint={
                probe.chartSources.length === 0
                  ? 'No source of the kind this installation’s chart needs was readable here — the App chart has nowhere to come from.'
                  : 'The Flux source the App chart is fetched from.'
              }
            />
          )}
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
  return (
    <SharedDeclaration
      label="manifest entry"
      note={
        <>
          The same connection, under <span className="font-mono">vessels:</span>{' '}
          and <span className="font-mono">targets:</span> in the installation
          manifest. A declaration seeds an installation that has none; it does
          not overwrite one that is already configured.
        </>
      }
      // Both arrays, because one connect act names a boundary and a surface on
      // it. The two seeds come from `domain/target-onboarding.ts`, which is
      // what the server connects with — so this is the act, not a rendering of
      // what somebody hopes the act is.
      text={JSON.stringify(
        { vessels: [vesselSeedOf(plan)], targets: [targetSeedOf(plan)] },
        null,
        2,
      )}
    />
  );
}

// --- The cloud flow, unchanged ---------------------------------------------

/**
 * A cloud project's Targets, in one act (§13).
 *
 * Still a flat form, and not because nobody got to it: a project has no
 * discovery API to enumerate itself through before it is named, so there is
 * nothing here for a probe to read. The region is carried from a working cloud
 * Target; the project id never is — except on an edit, where the id is this
 * boundary's own rather than somebody else's, and pressing the button again is
 * how a surface the last probe did not find gets asked about a second time.
 *
 * **No control for either endpoint.** Both used to be typed here on the theory
 * that they were connection material the way `apiServer` is; they are not —
 * `run.googleapis.com` and `firebasehosting.googleapis.com` answer for every
 * project, so `cloudrun/index.ts` and `static/index.ts` each apply their own
 * default and this form asks nothing about either. An installation behind a
 * perimeter or a mirror still has the override; it is declared in the manifest
 * (§20), which this screen never mediates.
 */
function ConnectCloud({
  vessel,
  project: knownProject = '',
  carried = {},
  proposal,
  connecting,
  onConnect,
  onCancel,
}: {
  vessel: string;
  project?: string;
  carried?: CloudBoundaryFacts;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [project, setProject] = useState(knownProject);
  const [region, setRegion] = useState(proposal.region ?? '');

  const ready = project.trim() !== '' && region.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          name="project"
          label="Project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          hint={
            knownProject === ''
              ? "Not carried — a second project prefilled with the first one's id would read as correct."
              : 'This boundary’s own id. Connecting again re-asks it about every surface.'
          }
        />
        <Field
          name="region"
          label="Region"
          value={region}
          onChange={(event) => setRegion(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!ready || connecting}
          onClick={() =>
            onConnect({
              kind: 'gcp-project',
              vessel,
              project: project.trim(),
              region: region.trim(),
              ...(proposal.policyEndpoint === undefined
                ? {}
                : { policyEndpoint: proposal.policyEndpoint }),
              // One act writes the whole connection and the whole vessel row,
              // so what this boundary already states has to go back with it or
              // the edit deletes it. There is no field for these because they
              // are not decisions being made again — the fresh-connect path
              // sends none, having nothing to preserve.
              ...carried,
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

/**
 * A Vercel team's one surface, in one act.
 *
 * Flat for the reason the cloud form above it is: a team has no discovery API
 * to enumerate itself through before it is named. One field, not two — there is
 * no region to pick, because the platform serves one network from one place,
 * and no control for the API root either: `api.vercel.com` answers for every
 * team, so `vercel/index.ts` applies it without asking. The only thing this
 * boundary can tell Spindrift that Spindrift could not already assume is which
 * team it is.
 *
 * **No field for the token**, and that is the point rather than an omission:
 * the bearer this Target is driven with is the installation's, read from its
 * Secret per request, so a form that took one would be storing a credential per
 * Target — the thing §13's rule is actually about. A team whose token is
 * missing or unauthorized connects anyway and reads `API_TOKEN` unmet, which is
 * §13's "connect always succeeds" doing its job.
 */
function ConnectVercel({
  vessel,
  team: knownTeam = '',
  connecting,
  onConnect,
  onCancel,
}: {
  vessel: string;
  team?: string;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [team, setTeam] = useState(knownTeam);
  const ready = team.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          name="team"
          label="Team"
          value={team}
          onChange={(event) => setTeam(event.target.value)}
          hint={
            knownTeam === ''
              ? "Not carried — a second team prefilled with the first one's slug would read as correct."
              : 'This boundary’s own slug or team_… id.'
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!ready || connecting}
          onClick={() =>
            onConnect({
              kind: 'vercel-team',
              vessel,
              team: team.trim(),
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

/**
 * A Cloudflare account's one surface, in one act.
 *
 * The same one field {@link ConnectVercel} takes, one vendor over and for the
 * same reason — an account has no discovery API to enumerate itself through
 * before it is named — plus the same omission: the platform's REST root
 * answers for every account, so `pages/index.ts` applies it without asking,
 * and the only thing left for this form to ask about is which account.
 *
 * **No field for the token here either**, and the same sentence applies: the
 * bearer is the installation's, read from its Secret per request, so a form
 * that took one would be storing a credential per Target. An account whose
 * token is missing or unscoped connects anyway and reads `API_TOKEN` unmet.
 */
function ConnectCloudflareAccount({
  vessel,
  account: knownAccount = '',
  connecting,
  onConnect,
  onCancel,
}: {
  vessel: string;
  account?: string;
  proposal: TargetConnectionProposal;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onCancel: () => void;
}) {
  const [account, setAccount] = useState(knownAccount);
  const ready = account.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          name="account"
          label="Account"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          hint={
            knownAccount === ''
              ? "Not carried — a second account prefilled with the first one's id would read as correct."
              : 'This boundary’s own account id.'
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!ready || connecting}
          onClick={() =>
            onConnect({
              kind: 'cloudflare-account',
              vessel,
              account: account.trim(),
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

/**
 * Which operator to start on.
 *
 * What a working Target of this installation already uses, when this cluster
 * serves it — that is the answer for the second cluster of a fleet, and the
 * whole point of carrying a proposal. Otherwise whatever this cluster was found
 * serving, and Flux when it was found serving neither: an unreadable cluster
 * gets a pick that is editable rather than a blank one that gates the button.
 */
function pickFlavour(
  served: readonly KubernetesDeliveryFlavour[],
  proposed: KubernetesDeliveryFlavour | undefined,
): KubernetesDeliveryFlavour {
  if (proposed !== undefined && served.includes(proposed)) return proposed;
  return served[0] ?? proposed ?? 'flux-helmrelease';
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
