/**
 * An App's shape: ingress, Components and Datastores, from the workspace read.
 * Every Component wires to every Datastore, because a Datastore attaches to the
 * App. Pressing a Component box selects it; nothing here edits the App.
 */
import { Database, Globe } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ComponentView, DatastoreView } from '../../commands/views.ts';
import { DATASTORE_VARIABLE, type Reach } from '../../domain/desired-state.ts';
import { Card } from '../ui/card.tsx';
import { cn } from '../ui/utils.ts';
import { PhaseDot } from './status.tsx';

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
  /** A reach, or the variable a connection arrives as. */
  readonly label: string;
  /** A store whose lifetime this platform does not own. */
  readonly dashed: boolean;
}

export interface TopologyLayout {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly width: number;
  readonly height: number;
}

const NODE_W = 184;
const COMPONENT_H = 78;
const STORE_H = 66;
const INGRESS_W = 124;
const INGRESS_H = 56;
const VGAP = 20;
// Each gap fits the longest edge label it carries: the node cards paint over
// the wire layer and would clip a longer one.
const INGRESS_GAP = 104;
const STORE_GAP = 148;

const stackHeight = (count: number, each: number): number =>
  count <= 0 ? 0 : count * each + (count - 1) * VGAP;

/** Centres a lane's stack against the tallest lane. */
const laneTop = (
  index: number,
  count: number,
  each: number,
  height: number,
): number => (height - stackHeight(count, each)) / 2 + index * (each + VGAP);

const exposed = (component: { readonly reach: Reach }): boolean =>
  component.reach !== 'none';

/**
 * The lanes shift left when nothing is exposed and the canvas narrows when
 * nothing is attached, so an App with neither is one column.
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
      // Reach alone cannot tell a proxied App from an open one.
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

/** `lit` and `dim` are never both true, and both are false at rest. */
function wire(
  from: TopologyNode,
  to: TopologyNode,
  edge: TopologyEdge,
  key: string,
  lit: boolean,
  dim: boolean,
) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const bend = Math.max(30, (x2 - x1) / 2);
  return (
    <g
      key={key}
      className={cn(
        'transition-opacity duration-150 ease-out',
        dim && 'opacity-25',
      )}
    >
      <path
        d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}
        className={cn(
          'fill-none transition-[stroke] duration-150 ease-out',
          lit ? 'stroke-primary' : 'stroke-border',
          edge.dashed && '[stroke-dasharray:4_4]',
        )}
        strokeWidth={lit ? 2 : 1.5}
      />
      <polygon
        points={`${x2 - 8},${y2 - 4.5} ${x2},${y2} ${x2 - 8},${y2 + 4.5}`}
        className={cn(
          'transition-[fill] duration-150 ease-out',
          lit ? 'fill-primary' : 'fill-border',
        )}
      />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 7}
        textAnchor="middle"
        // A halo stroke keeps the label legible over the ruled background.
        className={cn(
          'stroke-card font-mono text-[10px] transition-[fill] duration-150 ease-out [paint-order:stroke] [stroke-width:5px]',
          lit ? 'fill-accent-foreground' : 'fill-muted-foreground',
        )}
      >
        {edge.label}
      </text>
    </g>
  );
}
/**
 * A `<button>` only when a press does something, else a `div`. Hover goes
 * through `onPoint`, because the wires that react sit in a sibling layer.
 */
function Node({
  node,
  onPress,
  selected,
  onPoint,
  children,
}: {
  readonly node: TopologyNode;
  readonly onPress?: () => void;
  /** Passed on every Component box, never on one that navigates away. */
  readonly selected?: boolean;
  readonly onPoint: (id: string | null) => void;
  readonly children: ReactNode;
}) {
  const box = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
  } as const;

  const skin = cn(
    'absolute flex flex-col justify-center gap-1 rounded-sm px-3 text-left',
    // `transform` is the press, acknowledged in 100ms like `Button`.
    'transition-[border-color,background-color,transform] duration-100 ease-out',
    node.kind === INGRESS
      ? 'border border-dashed border-border'
      : 'border border-border bg-card',
    selected === true && 'border-primary bg-accent',
  );

  const point = {
    onPointerEnter: () => onPoint(node.id),
    onPointerLeave: () => onPoint(null),
  } as const;

  if (!onPress) {
    return (
      <div style={box} className={skin} {...point}>
        {children}
      </div>
    );
  }

  return (
    <button
      type="button"
      style={box}
      onClick={onPress}
      onFocus={() => onPoint(node.id)}
      onBlur={() => onPoint(null)}
      {...point}
      // Every Component box states it, so the pressed one means something.
      {...(selected === undefined ? {} : { 'aria-pressed': selected })}
      className={cn(
        skin,
        'cursor-pointer active:scale-[0.98]',
        selected !== true && 'hover:border-primary',
      )}
    >
      {children}
    </button>
  );
}

export function Topology({
  components,
  datastores,
  selectedId,
  onSelect,
  onNavigate,
  children,
}: {
  readonly components: readonly ComponentView[];
  readonly datastores: readonly DatastoreView[];
  /** An id; `onSelect` answers with a name, which the command takes. */
  readonly selectedId?: string;
  /** Absent on a fixed view, so no Component box can be pressed. */
  readonly onSelect?: (component: string) => void;
  readonly onNavigate?: (path: string) => void;
  /** The chosen box's caption, inside this card. */
  readonly children?: ReactNode;
}) {
  // The pointed-at box outranks the selection.
  const [pointed, setPointed] = useState<string | null>(null);

  // The workspace owns the empty state.
  if (components.length === 0) return null;

  const { nodes, edges, width, height } = topology(components, datastores);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const componentById = new Map(
    components.map((component) => [`component:${component.id}`, component]),
  );
  const storeById = new Map(
    datastores.map((datastore) => [`datastore:${datastore.id}`, datastore]),
  );

  const focus =
    pointed ?? (selectedId === undefined ? null : `component:${selectedId}`);
  const touches = (edge: TopologyEdge) =>
    edge.from === focus || edge.to === focus;
  // Only when some wires touch the focus and some do not; otherwise it would
  // dim every wire or light every wire.
  const emphasise =
    focus !== null && edges.some(touches) && !edges.every(touches);

  return (
    <Card>
      <div className="overflow-x-auto p-6">
        {/* Boxes and wires animate together, so no box leaves its wire. */}
        <div
          className="relative motion-safe:animate-rise"
          style={{ width, height }}
        >
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
              const mine = touches(edge);
              return wire(
                from,
                to,
                edge,
                `${edge.from}->${edge.to}:${index}`,
                emphasise && mine,
                emphasise && !mine,
              );
            })}
          </svg>

          {nodes.map((node) => {
            if (node.kind === INGRESS) {
              return (
                <Node key={node.id} node={node} onPoint={setPointed}>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Globe aria-hidden="true" className="size-3.5" />
                    <span className="font-mono text-micro uppercase tracking-eyebrow">
                      ingress
                    </span>
                  </span>
                  <span className="text-body font-semibold">Internet</span>
                </Node>
              );
            }

            const component = componentById.get(node.id);
            if (component) {
              return (
                <Node
                  key={node.id}
                  node={node}
                  onPoint={setPointed}
                  selected={component.id === selectedId}
                  {...(onSelect
                    ? { onPress: () => onSelect(component.name) }
                    : {})}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-micro uppercase tracking-eyebrow text-muted-foreground">
                      {component.kind}
                    </span>
                    {/* Right-aligned, so a column of boxes reads its phases
                        down one edge. */}
                    <span className="ml-auto">
                      <PhaseDot phase={component.phase} />
                    </span>
                  </span>
                  <span className="truncate text-ui font-semibold tracking-tight">
                    {component.name}
                  </span>
                  <span className="truncate font-mono text-caption text-muted-foreground">
                    {component.target ?? 'unplaced'}
                  </span>
                </Node>
              );
            }

            const datastore = storeById.get(node.id);
            if (!datastore) return null;
            return (
              <Node
                key={node.id}
                node={node}
                onPoint={setPointed}
                {...(onNavigate
                  ? {
                      onPress: () => onNavigate(`/datastores/${datastore.id}`),
                    }
                  : {})}
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
              </Node>
            );
          })}
        </div>
      </div>

      {children ? (
        <div className="border-t border-border-soft px-6 py-4">{children}</div>
      ) : null}

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
