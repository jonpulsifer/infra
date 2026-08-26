/**
 * The shape of an App, as boxes and the wires between them.
 *
 * The rendering is a `div` per node and a `path` per edge, and neither is worth
 * a test. What is worth one is the layout: it decides how many wires exist and
 * what each says, and both answers come from rules in §3 and §11 that a later
 * edit can invert without anything failing to render.
 *
 * Boxes that overlap, wires that point at nothing, and a label wider than the
 * gap it is centred in are all bugs that look like a picture.
 */
import { describe, expect, test } from 'bun:test';
import type { ComponentView, DatastoreView } from '../../src/commands/views.ts';
import { INGRESS, topology } from '../../src/web/components/topology.tsx';

function component(
  name: string,
  overrides: Partial<ComponentView> = {},
): ComponentView {
  return {
    id: `component-${name}`,
    name,
    kind: 'service',
    phase: 'LIVE',
    artifact: 'image · abc1234',
    reach: 'none',
    auth: 'none',
    ...overrides,
  };
}

function datastore(
  name: string,
  overrides: Partial<DatastoreView> = {},
): DatastoreView {
  return {
    id: `datastore-${name}`,
    name,
    engine: 'postgres',
    provenance: 'managed',
    attachedTo: 'blog',
    target: 'cluster · folly',
    phase: 'LIVE',
    ...overrides,
  } as DatastoreView;
}

/** Do two boxes share any area? */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe('what gets drawn', () => {
  test('a Component nothing can reach has no ingress at all', () => {
    // §3's `reach: none` is not "an address nobody uses" — there is no address.
    // Drawing the Internet beside a `job` would be a wire that does not exist.
    const { nodes, edges } = topology([component('worker')], []);
    expect(nodes.some((node) => node.id === INGRESS)).toBe(false);
    expect(edges).toHaveLength(0);
  });

  test('and the lane it would have taken is not left empty', () => {
    // The whole reason the lane is computed rather than fixed: a three-column
    // grid gives an unexposed single-Component App two columns of whitespace.
    const solo = topology([component('worker')], []);
    const exposed = topology([component('web', { reach: 'public' })], []);
    expect(solo.nodes[0]!.x).toBe(0);
    expect(solo.width).toBeLessThan(exposed.width);
  });

  test('an exposed Component gets one wire, and it says how far it carries', () => {
    const { edges } = topology([component('web', { reach: 'public' })], []);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.from).toBe(INGRESS);
    expect(edges[0]!.label).toBe('public');
  });

  test('a proxied Component says so, because open and proxied are not the same', () => {
    const { edges } = topology(
      [component('web', { reach: 'public', auth: 'proxy' })],
      [],
    );
    expect(edges[0]!.label).toBe('public · proxy');
  });

  test('only the exposed Components get a wire from the Internet', () => {
    const { edges } = topology(
      [component('web', { reach: 'public' }), component('worker')],
      [],
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to).toBe('component:component-web');
  });
});

describe('a Datastore is attached to the App, not to one Component', () => {
  test('so every Component gets a wire to it', () => {
    // §11's column is `datastores.appId`. The variable lands in every
    // Component of the App, and a wire to only the first would be a picture
    // that says the worker cannot reach the database.
    const { edges } = topology(
      [component('web'), component('worker')],
      [datastore('primary')],
    );
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.from).sort()).toEqual([
      'component:component-web',
      'component:component-worker',
    ]);
  });

  test('and the wire is labelled with the variable the engine fixes', () => {
    const pg = topology([component('web')], [datastore('primary')]);
    expect(pg.edges[0]!.label).toBe('DATABASE_URL');

    const cache = topology(
      [component('web')],
      [datastore('cache', { engine: 'valkey' })],
    );
    expect(cache.edges[0]!.label).toBe('REDIS_URL');
  });

  test('an external store is dashed and a managed one is not', () => {
    // The only encoding in the picture that a reader cannot infer, which is
    // why it is also the only one the caption explains.
    const managed = topology([component('web')], [datastore('primary')]);
    expect(managed.edges[0]!.dashed).toBe(false);

    const external = topology(
      [component('web')],
      [datastore('events', { provenance: 'external' })],
    );
    expect(external.edges[0]!.dashed).toBe(true);
  });

  test('two Components sharing one store is two wires converging', () => {
    // The fact a table of attachments structurally cannot show, and the
    // reason this component exists at all.
    const { edges } = topology(
      [component('web'), component('worker')],
      [datastore('cache', { engine: 'valkey' })],
    );
    expect(new Set(edges.map((edge) => edge.to)).size).toBe(1);
    expect(new Set(edges.map((edge) => edge.from)).size).toBe(2);
  });
});

describe('the geometry holds', () => {
  const busy = topology(
    [
      component('web', { reach: 'public', auth: 'proxy' }),
      component('worker'),
      component('cron', { kind: 'job' }),
    ],
    [
      datastore('primary'),
      datastore('cache', { engine: 'valkey', provenance: 'external' }),
    ],
  );

  test('no two boxes overlap', () => {
    for (const [i, a] of busy.nodes.entries()) {
      for (const b of busy.nodes.slice(i + 1)) {
        expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  test('every box is inside the canvas it declares', () => {
    for (const node of busy.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(busy.width);
      expect(node.y + node.height).toBeLessThanOrEqual(busy.height);
    }
  });

  test('every wire joins two boxes that exist', () => {
    const ids = new Set(busy.nodes.map((node) => node.id));
    for (const edge of busy.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  test('every wire runs left to right, so no arrowhead points backwards', () => {
    const byId = new Map(busy.nodes.map((node) => [node.id, node]));
    for (const edge of busy.edges) {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      expect(from.x + from.width).toBeLessThanOrEqual(to.x);
    }
  });

  test('every label fits the gap it is centred in', () => {
    // A label is painted on the wire layer and the node cards paint over it,
    // so one wider than its gap is clipped at both ends rather than crowded.
    // ~5.6px per character at the 10px mono the label is set in.
    const byId = new Map(busy.nodes.map((node) => [node.id, node]));
    for (const edge of busy.edges) {
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      const gap = to.x - (from.x + from.width);
      expect(edge.label.length * 5.6).toBeLessThanOrEqual(gap);
    }
  });

  test('the longest variable either engine can produce still fits', () => {
    // The gap is sized for a fixed vocabulary, so the test names it: if a
    // third engine arrives with a longer variable, this fails rather than
    // shipping a clipped label.
    const worst = topology([component('web')], [datastore('primary')]);
    const [from, to] = [worst.nodes[0]!, worst.nodes[1]!];
    const gap = to.x - (from.x + from.width);
    for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
      expect(variable.length * 5.6).toBeLessThanOrEqual(gap);
    }
  });
});

describe('the highlight only fires where it separates something', () => {
  // The rule the picture is read by: a wire is emphasised *against* other
  // wires, so a colour every wire wears distinguishes nothing.
  const touches = (edge: { from: string; to: string }, id: string) =>
    edge.from === id || edge.to === id;
  const emphasises = (
    edges: readonly { from: string; to: string }[],
    id: string,
  ) =>
    edges.some((edge) => touches(edge, id)) &&
    !edges.every((edge) => touches(edge, id));

  test('the one-Component App lights nothing, because every wire is its own', () => {
    // The common App, and the case a naive "does it touch the selection"
    // check turns into a canvas of solid accent.
    const { edges } = topology(
      [component('web', { reach: 'public' })],
      [datastore('primary')],
    );
    expect(emphasises(edges, 'component:component-web')).toBe(false);
  });

  test('a Component with no wires at all lights nothing either', () => {
    // Dimming every wire on the canvas to announce that this box has none of
    // them is a picture of the wrong thing.
    const { edges } = topology(
      [component('web', { reach: 'public' }), component('worker')],
      [],
    );
    expect(emphasises(edges, 'component:component-worker')).toBe(false);
  });

  test('and a Component sharing a canvas with wires that are not its own does', () => {
    const { edges } = topology(
      [component('web', { reach: 'public' }), component('worker')],
      [datastore('primary')],
    );
    expect(emphasises(edges, 'component:component-web')).toBe(true);
  });
});

describe('the degenerate cases', () => {
  test('no Components is no canvas', () => {
    const { nodes, edges, height } = topology([], []);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(height).toBe(0);
  });

  test('one Component and nothing else is one box', () => {
    const { nodes, width } = topology([component('web')], []);
    expect(nodes).toHaveLength(1);
    expect(width).toBe(nodes[0]!.width);
  });
});
