import { sankey as d3sankey, type SankeyNode, sankeyLeft } from 'd3-sankey';
import { useMemo, useState } from 'react';
import { useMeasure } from '../bits';
import { money, moneyShort } from '../model';
import { inkOn, type Palette } from '../theme';

export type FlowNode = { id: string; name: string; color: string };
export type FlowLink = {
  source: string;
  target: string;
  value: number;
  color: string;
};

const THICK = 20;
const LAYER = 150;

type LaidOut = SankeyNode<FlowNode, FlowLink>;

function fits(label: string, room: number) {
  return label.length * 6.3 + 14 <= room;
}

/**
 * A Sankey laid out top to bottom: d3-sankey computes it sideways and the
 * render swaps the axes, so depth runs down the phone.
 */
export function FlowSankey({
  nodes,
  links,
  pal,
  onNode,
  label,
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  pal: Palette;
  onNode?: (id: string) => void;
  label: string;
}) {
  const [box, w] = useMeasure<HTMLDivElement>();
  const [hot, setHot] = useState<string | null>(null);

  const graph = useMemo(() => {
    if (!w || !links.length) return null;
    const depth = new Map<string, number>();
    const ids = new Set(links.flatMap((l) => [l.source, l.target]));
    const used = nodes.filter((n) => ids.has(n.id));
    const layout = d3sankey<FlowNode, FlowLink>()
      .nodeId((n) => n.id)
      .nodeAlign(sankeyLeft)
      .nodeSort(null)
      .nodeWidth(THICK)
      .nodePadding(5);
    const probe = layout.extent([
      [0, 0],
      [1000, w],
    ])({
      nodes: used.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
    for (const n of probe.nodes) depth.set(n.id, n.depth ?? 0);
    const layers = Math.max(...Array.from(depth.values())) + 1;
    const h = (layers - 1) * LAYER + THICK;
    const g = layout.extent([
      [0, 0],
      [h, w],
    ])({
      nodes: used.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
    return { ...g, h };
  }, [nodes, links, w]);

  let readout = 'Tap a band or a category';
  if (graph && hot) {
    const n = graph.nodes.find((x) => x.id === hot);
    const l = graph.links.find(
      (x) =>
        `${(x.source as FlowNode).id}>${(x.target as FlowNode).id}` === hot,
    );
    if (n) readout = `${n.name} · ${money(n.value ?? 0)}`;
    else if (l)
      readout = `${(l.source as FlowNode).name} → ${(l.target as FlowNode).name} · ${money(l.value)}`;
  }

  return (
    <div ref={box} className="w-full">
      <p
        aria-live="polite"
        className="mb-2 min-h-5 truncate text-sm font-medium text-stone-700 tabular-nums dark:text-stone-300"
      >
        {readout}
      </p>
      {graph ? (
        <svg
          width={w}
          height={graph.h}
          role="img"
          aria-label={label}
          className="block overflow-visible"
          onPointerLeave={() => setHot(null)}
          onPointerOver={(e) => {
            const k = (e.target as Element).getAttribute('data-k');
            if (k) setHot(k);
          }}
        >
          {graph.links.map((l) => {
            const s = l.source as LaidOut;
            const t = l.target as LaidOut;
            const key = `${s.id}>${t.id}`;
            const half = Math.max(0.5, (l.width ?? 0) / 2);
            const a = l.y0 ?? 0;
            const b = l.y1 ?? 0;
            const sy = s.x1 ?? 0;
            const ty = t.x0 ?? 0;
            const my = (sy + ty) / 2;
            const d = `M${a - half},${sy} C${a - half},${my} ${b - half},${my} ${b - half},${ty} L${b + half},${ty} C${b + half},${my} ${a + half},${my} ${a + half},${sy} Z`;
            const on = hot === key;
            return (
              <path
                key={key}
                d={d}
                fill={l.color}
                fillOpacity={
                  on
                    ? pal.linkAlpha + 0.3
                    : hot
                      ? pal.linkAlpha / 2
                      : pal.linkAlpha
                }
                style={{ transition: 'fill-opacity 150ms' }}
                data-k={key}
              />
            );
          })}
          {graph.nodes.map((n) => {
            const x = n.y0 ?? 0;
            const y = n.x0 ?? 0;
            const nw = Math.max(1, (n.y1 ?? 0) - x);
            const full = `${n.name} ${moneyShort(n.value ?? 0)}`;
            const text = fits(full, nw) ? full : fits(n.name, nw) ? n.name : '';
            return (
              <g
                key={n.id}
                role="button"
                tabIndex={0}
                aria-label={`${n.name}: ${money(n.value ?? 0)}`}
                className="cursor-pointer outline-none"
                onPointerEnter={() => setHot(n.id)}
                onFocus={() => setHot(n.id)}
                onClick={() => {
                  setHot(n.id);
                  onNode?.(n.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onNode?.(n.id);
                  }
                }}
              >
                <rect
                  x={x}
                  y={y - 6}
                  width={nw}
                  height={THICK + 12}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={y}
                  width={nw}
                  height={THICK}
                  rx={4}
                  fill={n.color}
                  stroke={hot === n.id ? pal.ink : 'none'}
                  strokeWidth={1.5}
                />
                {text ? (
                  <text
                    x={x + nw / 2}
                    y={y + THICK / 2 + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill={inkOn(n.color)}
                    pointerEvents="none"
                  >
                    {text}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="grid h-40 place-items-center rounded-2xl text-sm text-stone-500">
          Nothing moved in this period.
        </div>
      )}
    </div>
  );
}
