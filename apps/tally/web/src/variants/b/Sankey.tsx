import {
  sankey as d3Sankey,
  type SankeyLink,
  type SankeyNode,
  sankeyLinkHorizontal,
} from 'd3-sankey';
import { useMemo, useState } from 'react';
import { Tooltip, useWidth } from './bits';
import { type FlowLink, type FlowNode, money } from './model';
import { GROUP_ORDER, groupColor } from './theme';

type N = SankeyNode<FlowNode, FlowLink>;
type L = SankeyLink<FlowNode, FlowLink>;

type Hover =
  | { kind: 'link'; index: number; x: number; y: number }
  | { kind: 'node'; id: string; x: number; y: number }
  | null;

function rank(n: FlowNode) {
  if (n.id === 'src:savings' || n.id === 'leaf:saved') return 1000;
  if (n.kind === 'source' || n.id === 'all') return 0;
  const g = GROUP_ORDER.indexOf(n.groupId);
  return (g < 0 ? 50 : g) * 10 + (n.kind === 'group' ? 0 : 1);
}

function linkColor(l: L) {
  const t = l.target as N;
  if (t.id === 'all') return 'var(--flow)';
  return groupColor(t.groupId);
}

export function SankeyFlow({
  nodes,
  links,
  income,
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  income: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover>(null);
  const narrow = width < 700;
  const h = narrow ? 560 : 660;
  const m = narrow
    ? { left: 112, right: 120, top: 12, bottom: 12 }
    : { left: 170, right: 200, top: 16, bottom: 16 };

  const graph = useMemo(() => {
    if (width <= 0 || !links.length) return null;
    const layout = d3Sankey<FlowNode, FlowLink>()
      .nodeId((d) => d.id)
      .nodeWidth(6)
      .nodePadding(narrow ? 9 : 12)
      .nodeSort((a, b) => rank(a) - rank(b) || (b.value ?? 0) - (a.value ?? 0))
      .extent([
        [m.left, m.top],
        [width - m.right, h - m.bottom],
      ]);
    return layout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [nodes, links, width, narrow, h, m.left, m.right, m.top, m.bottom]);

  const path = sankeyLinkHorizontal<FlowNode, FlowLink>();
  const maxX = graph ? Math.max(...graph.nodes.map((n) => n.x0 ?? 0)) : 0;

  const active = (l: L, i: number) => {
    if (!hover) return null;
    if (hover.kind === 'link') return hover.index === i;
    const s = l.source as N;
    const t = l.target as N;
    return s.id === hover.id || t.id === hover.id;
  };

  const opacity = (l: L, i: number) => {
    const a = active(l, i);
    const t = l.target as N;
    const s = l.source as N;
    const emphasised = t.id === 'leaf:saved' || s.id === 'src:savings';
    if (a === null) return emphasised ? 0.7 : 0.32;
    return a ? 0.78 : 0.06;
  };

  const tip = (() => {
    if (!hover || !graph) return null;
    if (hover.kind === 'link') {
      const l = graph.links[hover.index];
      const s = l.source as N;
      const t = l.target as N;
      return {
        title: `${s.name} → ${t.name}`,
        rows: [
          {
            label: income
              ? `${Math.round((l.value / income) * 100)}% of income`
              : '',
            value: money(l.value),
            color: linkColor(l),
          },
        ],
      };
    }
    const n = graph.nodes.find((x) => x.id === hover.id);
    if (!n) return null;
    return {
      title: n.name,
      rows: [
        {
          label: income
            ? `${Math.round(((n.value ?? 0) / income) * 100)}% of income`
            : '',
          value: money(n.value ?? 0),
          color:
            n.kind === 'source' || n.id === 'all'
              ? 'var(--ink2)'
              : groupColor(n.groupId),
        },
      ],
    };
  })();

  return (
    <div ref={ref} className="relative w-full">
      {graph ? (
        <svg
          width={width}
          height={h}
          role="img"
          aria-label="Where income went: sources into income, then spending groups and categories, and what was saved"
          className="block"
          onPointerLeave={() => setHover(null)}
        >
          <g fill="none">
            {graph.links.map((l, i) => (
              <path
                key={`${(l.source as N).id}-${(l.target as N).id}`}
                d={path(l) ?? ''}
                stroke={linkColor(l)}
                strokeOpacity={opacity(l, i)}
                strokeWidth={Math.max(1, l.width ?? 1)}
                className="cursor-default transition-[stroke-opacity] duration-200"
                onPointerMove={(e) => {
                  const box = (
                    e.currentTarget.ownerSVGElement as SVGSVGElement
                  ).getBoundingClientRect();
                  setHover({
                    kind: 'link',
                    index: i,
                    x: e.clientX - box.left,
                    y: e.clientY - box.top,
                  });
                }}
              />
            ))}
          </g>
          {graph.nodes.map((n) => {
            const x0 = n.x0 ?? 0;
            const x1 = n.x1 ?? 0;
            const y0 = n.y0 ?? 0;
            const y1 = n.y1 ?? 0;
            const nh = y1 - y0;
            const right = x0 >= maxX - 1;
            const left = n.kind === 'source';
            const lx = left ? x0 - 10 : x1 + 10;
            const anchor = left ? 'end' : 'start';
            const color =
              n.kind === 'source' || n.id === 'all'
                ? 'var(--ink)'
                : groupColor(n.groupId);
            const isSaved = n.id === 'leaf:saved';
            const isIncome = n.id === 'all';
            const dim = hover?.kind === 'node' && hover.id !== n.id ? 0.45 : 1;
            const twoLine = nh >= 28 || isIncome || isSaved;
            const show = nh >= 9 || isSaved;
            return (
              <g
                key={n.id}
                opacity={dim}
                className="transition-opacity duration-200"
              >
                <rect
                  x={x0}
                  y={y0}
                  width={x1 - x0}
                  height={Math.max(1, nh)}
                  rx={2}
                  fill={color}
                />
                {show ? (
                  <text
                    x={lx}
                    y={(y0 + y1) / 2}
                    textAnchor={anchor}
                    className={!right && !left ? 'halo' : undefined}
                    fill="var(--ink)"
                  >
                    {twoLine ? (
                      <>
                        <tspan
                          x={lx}
                          dy="-0.25em"
                          fontSize={isIncome || isSaved ? 15 : 13}
                          fontWeight={isIncome || isSaved ? 600 : 500}
                          className={isIncome || isSaved ? 'serif' : undefined}
                        >
                          {n.name}
                        </tspan>
                        <tspan
                          x={lx}
                          dy="1.3em"
                          fontSize={12}
                          fill="var(--ink2)"
                          className="num"
                        >
                          {money(n.value ?? 0)}
                          {isSaved && income && !narrow
                            ? ` · ${Math.round(((n.value ?? 0) / income) * 100)}% of income`
                            : ''}
                        </tspan>
                      </>
                    ) : (
                      <tspan dy="0.32em" fontSize={12}>
                        {n.name}
                        {narrow && right ? null : (
                          <tspan fill="var(--ink2)" className="num">
                            {'  '}
                            {money(n.value ?? 0)}
                          </tspan>
                        )}
                      </tspan>
                    )}
                  </text>
                ) : null}
                <rect
                  x={x0 - 8}
                  y={y0 - 2}
                  width={x1 - x0 + 16}
                  height={Math.max(8, nh + 4)}
                  fill="transparent"
                  onPointerMove={(e) => {
                    const box = (
                      e.currentTarget.ownerSVGElement as SVGSVGElement
                    ).getBoundingClientRect();
                    setHover({
                      kind: 'node',
                      id: n.id,
                      x: e.clientX - box.left,
                      y: e.clientY - box.top,
                    });
                  }}
                />
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
      {hover && tip ? (
        <Tooltip
          x={hover.x}
          y={hover.y}
          width={width}
          title={tip.title}
          rows={tip.rows}
        />
      ) : null}
    </div>
  );
}
