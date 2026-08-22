/**
 * What this App is made of, and what it talks to (§2, §3, §11).
 *
 * The workspace already lists Components and names the Datastores an App reads
 * through. What a list cannot show is the **shape**: that two Components share
 * one store, that only one of them is reachable from outside, that a store is
 * one nobody here provisions. Those are facts about the edges between things,
 * and a column of rows has no edges.
 *
 * **Nothing here is new data.** Every value is already on `WorkspaceView` —
 * `reach` and `auth` decide whether an ingress edge exists and what it says,
 * `DATASTORE_VARIABLE` turns an engine into the variable its connection
 * arrives as, and `provenance` decides whether this platform owns the store's
 * lifetime. The picture is a second reading of the same read, not a second
 * read.
 *
 * **Every Component gets an edge to every Datastore, and that is not a
 * simplification.** §11 attaches a Datastore to the *App*, not to a Component —
 * `datastores.appId` is the column, and `attachDatastore` refuses a second
 * store of the same engine because "both would arrive as the same variable".
 * So the variable lands in every Component of the App, and the fan-out is the
 * honest drawing. `views.ts` calls `attachedTo` "the Component it is attached
 * to"; that comment is wrong, and `workspace.ts` already says so beside the
 * line that fills it with the App's first Component as a display convenience.
 *
 * It is a picture, not a control surface. Selecting a Component, attaching a
 * store and changing reach all live in the sections below, which is where the
 * reader already looks for a verb — a diagram that duplicated them would be a
 * second place for each act to be wrong.
 */
import { Database, Globe } from 'lucide-react';
import type { ComponentView, DatastoreView } from '../../commands/views.ts';
import { DATASTORE_VARIABLE, type Reach } from '../../domain/desired-state.ts';
import { Card } from '../ui/card.tsx';
import { cn } from '../ui/utils.ts';

/** The one node kind that is not a row in the read: the world outside. */
export const INGRESS = 'ingress';

export interface TopologyNode {
  readonly id: string;
  readonly kind: 'ingress' | 'component' | 'datastore';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TopologyEdge {
  readonly from: string;
  readonly to: string;
  /** What travels along it — a reach, or the variable a connection arrives as. */
  readonly label: string;
  /**
   * A store whose lifetime this platform does not own (§11's `external`).
   * Dashed rather than a legend entry: it is one encoding used in one place.
   */
  readonly dashed: boolean;
}

export interface TopologyLayout {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly width: number;
  readonly height: number;
}

/*
 * The box sizes, and the two gaps that are not decoration.
 *
 * `INGRESS_GAP` and `STORE_GAP` are wide enough for the longest label each
 * carries, because an edge label is centred in its gap and the node cards are
 * painted over the wire layer — a label longer than its gap is a label with
 * its ends clipped by two boxes. `EVENTS_DATABASE_URL`-length names are the
 * ones that set the floor.
 */
const NODE_W = 184;
const COMPONENT_H = 78;
const STORE_H = 66;
const INGRESS_W = 124;
const INGRESS_H = 56;
const VGAP = 20;
const INGRESS_GAP = 104;
const STORE_GAP = 148;

const stackHeight = (count: number, each: number): number =>
  count <= 0 ? 0 : count * each + (count - 1) * VGAP;

/** Centre a lane's stack against the tallest lane, so the rows read as rows. */
const laneTop = (
  index: number,
  count: number,
  each: number,
  height: number,
): number => (height - stackHeight(count, each)) / 2 + index * (each + VGAP);

/** Whether a Component is reachable from outside at all (§3). */
const exposed = (component: { readonly reach: Reach }): boolean =>
  component.reach !== 'none';

/**
 * Where every box goes and what every wire says.
 *
 * Separated from the rendering because this is the part with an opinion. The
 * lanes shift left when nothing is exposed and the canvas narrows when nothing
 * is attached, so an App with neither is one column of boxes rather than one
 * column of boxes and two columns of whitespace — which is what a fixed
 * three-lane grid gives a `job` that reads no store.
 */
export function topology(
  components: readonly ComponentView[],
  datastores: readonly DatastoreView[],
): TopologyLayout {
  const outward = components.filter(exposed);
  const hasIngress = outward.length > 0;
  const componentX = hasIngress ? INGRESS_W + INGRESS_GAP : 0;
  const storeX = componentX + NODE_W + STORE_GAP;
  const width = datastores.length > 0 ? storeX + NODE_W : componentX + NODE_W;
  const height = Math.max(
    stackHeight(components.length, COMPONENT_H),
    stackHeight(datastores.length, STORE_H),
    hasIngress ? INGRESS_H : 0,
  );

  const nodes: TopologyNode[] = [];
  if (hasIngress) {
    nodes.push({
      id: INGRESS,
      kind: 'ingress',
      x: 0,
      y: (height - INGRESS_H) / 2,
      width: INGRESS_W,
      height: INGRESS_H,
    });
  }
  components.forEach((component, index) => {
    nodes.push({
      id: `component:${component.id}`,
      kind: 'component',
      x: componentX,
      y: laneTop(index, components.length, COMPONENT_H, height),
      width: NODE_W,
      height: COMPONENT_H,
    });
  });
  datastores.forEach((datastore, index) => {
    nodes.push({
      id: `datastore:${datastore.id}`,
      kind: 'datastore',
      x: storeX,
      y: laneTop(index, datastores.length, STORE_H, height),
      width: NODE_W,
      height: STORE_H,
    });
  });

  const edges: TopologyEdge[] = [];
  for (const component of outward) {
    edges.push({
      from: INGRESS,
      to: `component:${component.id}`,
      // The two facts §3 keeps apart: how far the address carries, and who
      // gets past it. A reader who sees only "public" cannot tell a proxied
      // App from an open one, and that is the difference that matters.
      label:
        component.auth === 'proxy'
          ? `${component.reach} · proxy`
          : component.reach,
      dashed: false,
    });
  }
  for (const datastore of datastores) {
    for (const component of components) {
      edges.push({
        from: `component:${component.id}`,
        to: `datastore:${datastore.id}`,
        label: DATASTORE_VARIABLE[datastore.engine],
        dashed: datastore.provenance === 'external',
      });
    }
  }

  return { nodes, edges, width, height };
}

/** One wire, as a curve that leaves rightwards and arrives rightwards. */
function wire(
  from: TopologyNode,
  to: TopologyNode,
  edge: TopologyEdge,
  key: string,
) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const bend = Math.max(30, (x2 - x1) / 2);
  return (
    <g key={key}>
      <path
        d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}
        className={cn(
          'fill-none stroke-border',
          edge.dashed && '[stroke-dasharray:4_4]',
        )}
        strokeWidth={1.5}
      />
      <polygon
        points={`${x2 - 8},${y2 - 4.5} ${x2},${y2} ${x2 - 8},${y2 + 4.5}`}
        className="fill-border"
      />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 7}
        textAnchor="middle"
        // The halo. The node cards paint over this layer, so a label that
        // overhangs its gap would be clipped rather than merely crowded; the
        // stroke keeps it legible where it crosses the ruled background.
        className="fill-muted-foreground stroke-card font-mono text-[10px] [paint-order:stroke] [stroke-width:5px]"
      >
        {edge.label}
      </text>
    </g>
  );
}

export function Topology({
  components,
  datastores,
}: {
  readonly components: readonly ComponentView[];
  readonly datastores: readonly DatastoreView[];
}) {
  // An App with nothing in it has no shape to draw, and the Components section
  // below already owns that empty state — two of them is one too many.
  if (components.length === 0) return null;

  const { nodes, edges, width, height } = topology(components, datastores);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const componentById = new Map(
    components.map((component) => [`component:${component.id}`, component]),
  );
  const storeById = new Map(
    datastores.map((datastore) => [`datastore:${datastore.id}`, datastore]),
  );

  return (
    <Card>
      <div className="overflow-x-auto p-6">
        <div className="relative" style={{ width, height }}>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="pointer-events-none absolute inset-0 overflow-visible"
          >
            <title>Connections between this App's parts</title>
            {edges.map((edge, index) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              return wire(from, to, edge, `${edge.from}->${edge.to}:${index}`);
            })}
          </svg>

          {nodes.map((node) => {
            const box = {
              left: node.x,
              top: node.y,
              width: node.width,
              height: node.height,
            } as const;

            if (node.kind === INGRESS) {
              return (
                <div
                  key={node.id}
                  style={box}
                  className="absolute flex flex-col justify-center gap-1 rounded-sm border border-dashed border-border px-3"
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Globe aria-hidden="true" className="size-3.5" />
                    <span className="font-mono text-micro uppercase tracking-eyebrow">
                      ingress
                    </span>
                  </span>
                  <span className="text-body font-semibold">Internet</span>
                </div>
              );
            }

            const component = componentById.get(node.id);
            if (component) {
              return (
                <div
                  key={node.id}
                  style={box}
                  className="absolute flex flex-col justify-center gap-1.5 rounded-sm border border-border bg-card px-3"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-micro uppercase tracking-eyebrow text-muted-foreground">
                      {component.kind}
                    </span>
                  </span>
                  <span className="truncate text-ui font-semibold tracking-tight">
                    {component.name}
                  </span>
                  <span className="truncate font-mono text-caption text-muted-foreground">
                    {component.target ?? 'unplaced'}
                  </span>
                </div>
              );
            }

            const datastore = storeById.get(node.id);
            if (!datastore) return null;
            return (
              <div
                key={node.id}
                style={box}
                className="absolute flex flex-col justify-center gap-1 rounded-sm border border-border bg-card px-3"
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Database aria-hidden="true" className="size-3.5" />
                  <span className="font-mono text-micro uppercase tracking-eyebrow">
                    {datastore.provenance}
                  </span>
                </span>
                <span className="truncate text-body font-semibold">
                  {datastore.name}
                </span>
                <span className="font-mono text-caption text-muted-foreground">
                  {datastore.engine}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/*
        The one encoding that is not self-evident, stated only where it is used.
        An external store is one somebody else authored the URL for: Spindrift
        injects it and stays out of its lifetime, so nothing here provisions,
        backs up or destroys it.
      */}
      {datastores.some((datastore) => datastore.provenance === 'external') ? (
        <p className="flex items-center gap-2 border-t border-border-soft px-6 py-3 text-caption text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block w-6 border-t border-dashed border-muted-foreground"
          />
          A dashed edge is an external Datastore — injected, but not this
          platform's to provision or destroy.
        </p>
      ) : null}
    </Card>
  );
}
