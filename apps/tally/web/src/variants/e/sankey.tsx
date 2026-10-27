import {
  sankey as d3Sankey,
  type SankeyLink,
  type SankeyNode,
  sankeyLinkHorizontal,
} from 'd3-sankey';
import { useMemo, useState } from 'react';
import type { SankeyData } from '~/fixtures/derive';
import { TipLayer, TipRow, useTip, useWidth } from './bits';
import { CAT_ORDER, cx, money, type Palette, pct, tw } from './theme';

type FNode = {
  id: string;
  name: string;
  kind: 'source' | 'group' | 'leaf';
  group: string;
  color: string;
};
type FLink = { source: string; target: string; value: number };
type N = SankeyNode<FNode, FLink>;
type L = SankeyLink<FNode, FLink>;

type Focus = { kind: 'link'; key: string } | { kind: 'node'; id: string };

const SAVED = 'leaf:saved';
const DRAWN = 'src:drawdown';

function rank(n: FNode) {
  if (n.id === SAVED || n.id === DRAWN) return 1000;
  if (n.kind === 'source' || n.id === 'all') return 0;
  const g = (CAT_ORDER as readonly string[]).indexOf(n.group);
  return (g < 0 ? 50 : g) * 10 + (n.kind === 'group' ? 0 : 1);
}

const keyOf = (l: L) => `${(l.source as N).id}→${(l.target as N).id}`;

/** Income to groups to categories. Ribbons follow the pointer; the Saved ribbon is always lit. */
export function FlowSankey({
  data,
  pal,
  colorFor,
  groupOf,
}: {
  data: SankeyData;
  pal: Palette;
  colorFor: (id: string) => string;
  groupOf: (id: string) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { host, tip, show, hide } = useTip();
  const [focus, setFocus] = useState<Focus | null>(null);
  const narrow = width < 760;
  const h = narrow ? 520 : 560;
  const m = narrow
    ? { l: 118, r: 128, t: 10, b: 10 }
    : { l: 176, r: 224, t: 14, b: 14 };

  const graph = useMemo(() => {
    const links = data.links.filter((l) => l.value > 0);
    if (width < 320 || !links.length) return null;
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    const nodes: FNode[] = data.nodes
      .filter((n) => used.has(n.id))
      .map((n) => ({ ...n, group: groupOf(n.id), color: colorFor(n.id) }));
    return d3Sankey<FNode, FLink>()
      .nodeId((d) => d.id)
      .nodeWidth(7)
      .nodePadding(narrow ? 9 : 11)
      .nodeSort((a, b) => rank(a) - rank(b) || (b.value ?? 0) - (a.value ?? 0))
      .extent([
        [m.l, m.t],
        [width - m.r, h - m.b],
      ])({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });
  }, [data, width, narrow, h, m.l, m.r, m.t, m.b, colorFor, groupOf]);

  const income = graph?.nodes.find((n) => n.id === 'all')?.value ?? 0;
  const path = sankeyLinkHorizontal<FNode, FLink>();
  const maxX = graph ? Math.max(...graph.nodes.map((n) => n.x0 ?? 0)) : 0;

  const lit = (l: L) => {
    if (!focus) return null;
    if (focus.kind === 'link') return keyOf(l) === focus.key;
    return (l.source as N).id === focus.id || (l.target as N).id === focus.id;
  };
  const linkColor = (l: L) => {
    const t = l.target as N;
    const s = l.source as N;
    if (t.id === 'all') return s.id === DRAWN ? pal.bad : pal.flow;
    return t.color;
  };
  const opacity = (l: L) => {
    const a = lit(l);
    const t = l.target as N;
    const s = l.source as N;
    const hero = t.id === SAVED || s.id === DRAWN;
    if (a === null) return hero ? 0.62 : 0.24;
    return a ? 0.72 : hero ? 0.16 : 0.05;
  };
  const share = (v: number) => (income ? pct(v / income, 1) : '—');

  const linkTip = (l: L) => (
    <>
      <div className={cx('mb-1 font-medium', tw.ink2)}>
        {(l.source as N).name} → {(l.target as N).name}
      </div>
      <TipRow color={linkColor(l)} label="Flow" value={money(l.value, false)} />
      <TipRow label="Of income" value={share(l.value)} />
    </>
  );
  const nodeTip = (n: N) => (
    <>
      <div className={cx('mb-1 font-medium', tw.ink2)}>{n.name}</div>
      <TipRow
        color={n.color}
        shape="rect"
        label="Total"
        value={money(n.value ?? 0, false)}
      />
      {n.id !== 'all' ? (
        <TipRow label="Of income" value={share(n.value ?? 0)} />
      ) : null}
    </>
  );

  return (
    <div ref={host} className="relative">
      <div ref={ref} className="w-full" style={{ height: h }}>
        {graph ? (
          <svg
            width={width}
            height={h}
            role="img"
            aria-label="Where income went: sources into income, then spending groups and categories, and what was saved"
            className="block"
            onPointerLeave={() => {
              setFocus(null);
              hide();
            }}
          >
            <g fill="none">
              {graph.links.map((l) => (
                <path
                  key={keyOf(l)}
                  d={path(l) ?? ''}
                  stroke={linkColor(l)}
                  strokeOpacity={opacity(l)}
                  strokeWidth={Math.max(1, l.width ?? 1)}
                  style={{ transition: 'stroke-opacity 160ms' }}
                  onPointerMove={(e) => {
                    setFocus({ kind: 'link', key: keyOf(l) });
                    show(e, linkTip(l));
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
              const left = n.kind === 'source';
              const right = x0 >= maxX - 1;
              const lx = left ? x0 - 9 : x1 + 9;
              const big = n.id === 'all' || n.id === SAVED;
              const twoLine = big || nh >= 30;
              const visible = nh >= 8 || big || n.id === DRAWN;
              const dim = focus?.kind === 'node' && focus.id !== n.id ? 0.5 : 1;
              return (
                <g
                  key={n.id}
                  opacity={dim}
                  style={{ transition: 'opacity 160ms' }}
                >
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0}
                    height={Math.max(1, nh)}
                    rx={2}
                    fill={n.color}
                  />
                  {visible ? (
                    <text
                      x={lx}
                      y={(y0 + y1) / 2}
                      textAnchor={left ? 'end' : 'start'}
                      fill={pal.ink}
                      stroke={!left && !right ? pal.surface : undefined}
                      strokeWidth={!left && !right ? 4 : undefined}
                      paintOrder="stroke"
                      strokeLinejoin="round"
                    >
                      {twoLine ? (
                        <>
                          <tspan
                            x={lx}
                            dy="-0.2em"
                            fontSize={big ? 17 : 12}
                            fontWeight={big ? 400 : 500}
                            className={big ? tw.serif : undefined}
                          >
                            {n.name}
                          </tspan>
                          <tspan
                            x={lx}
                            dy="1.3em"
                            fontSize={11}
                            fill={pal.ink2}
                            className="font-mono tabular-nums"
                          >
                            {money(n.value ?? 0, false)}
                            {n.id === SAVED && !narrow
                              ? ` · ${share(n.value ?? 0)} of income`
                              : ''}
                          </tspan>
                        </>
                      ) : (
                        <tspan dy="0.32em" fontSize={11}>
                          {n.name}
                          {narrow && right ? null : (
                            <tspan
                              fill={pal.ink3}
                              dx={6}
                              className="font-mono tabular-nums"
                            >
                              {money(n.value ?? 0, false)}
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
                    height={Math.max(10, nh + 4)}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.name}: ${money(n.value ?? 0, false)}`}
                    className="outline-none"
                    onPointerMove={(e) => {
                      setFocus({ kind: 'node', id: n.id });
                      show(e, nodeTip(n));
                    }}
                    onFocus={(e) => {
                      setFocus({ kind: 'node', id: n.id });
                      show(e, nodeTip(n));
                    }}
                    onBlur={() => {
                      setFocus(null);
                      hide();
                    }}
                  />
                </g>
              );
            })}
          </svg>
        ) : (
          <div
            className={cx(
              'flex h-full items-center justify-center text-[12px]',
              tw.ink3,
            )}
          >
            No income or spend in this slice.
          </div>
        )}
      </div>
      <TipLayer tip={tip} width={width} />
    </div>
  );
}
