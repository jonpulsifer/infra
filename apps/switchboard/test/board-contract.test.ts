// The board names the folly PBX's dialplan, its ARI channel variables and the
// paths its network policy admits; these tests read those files and fail when
// either side is renamed without the other. turbo.json and typescript.yml list
// the files as inputs to this package's tests.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARI_LISTS, METRICS_PATH } from '../src/board/ari.ts';
import { CHANNEL_VARS, SUBROUTINES, VERDICTS } from '../src/board/model.ts';
import type { Direction, StageInput } from '../src/board/stage.ts';
import { AGENT_ENDPOINT, stageOf } from '../src/board/stage.ts';

const PBX = join(import.meta.dir, '../../../clusters/folly/apps/pbx');
const CONFIG = join(PBX, 'config');
const present = existsSync(CONFIG);

function read(file: string): string {
  return readFileSync(join(CONFIG, file), 'utf8');
}

/** Each context the dialplan files declare, with its extensions. */
function dialplan(): Map<string, Set<string>> {
  const contexts = new Map<string, Set<string>>();
  for (const file of readdirSync(CONFIG).filter((f) => f.endsWith('.conf'))) {
    let context: Set<string> | undefined;
    for (const raw of read(file).split('\n')) {
      const line = raw.replace(/;.*/, '').trim();
      const header = /^\[([^\]]+)\]/.exec(line)?.[1];
      if (header) {
        context = contexts.get(header) ?? new Set();
        contexts.set(header, context);
        continue;
      }
      const exten = /^exten\s*=>\s*([^,]+),/.exec(line)?.[1];
      if (exten) context?.add(exten.trim());
    }
  }
  return contexts;
}

function place(
  direction: Direction,
  context: string,
  exten: string,
  app = '',
  appData = '',
): StageInput {
  return {
    direction,
    place: { context, exten, app, appData },
    vars: {},
    trunk: null,
    bridgedTo: null,
    dialling: null,
  };
}

describe.skipIf(!present)('the board and the folly dialplan', () => {
  const contexts = present ? dialplan() : new Map<string, Set<string>>();
  const text = present
    ? readdirSync(CONFIG)
        .filter((f) => f.endsWith('.conf'))
        .map(read)
        .join('\n')
    : '';

  const places: [Direction, string, string, string][] = [
    ['inbound', 'from-voipms', 'human', 'pressed 5 → ringing desk'],
    ['inbound', 'from-voipms', 'contact', 'contact → ringing desk'],
    ['inbound', 'from-voipms', 'ring', 'ringing desk (unscreened line)'],
    ['inbound', 'from-voipms', 'busy', 'refused (busy)'],
    ['inbound', 'spam', 's', 'into the sinks'],
    ['inbound', 'spam', 'queue', 'held: Endless Queue'],
    ['inbound', 'spam', 'lenny', 'held: Robo-Lenny'],
    ['inbound', 'spam', 'full', 'refused (full)'],
    ['inbound', 'agent', 's', 'with Earl'],
    ['inbound', 'agent', 'dial', 'with Earl'],
  ];
  for (const [direction, context, exten, label] of places) {
    test(`${context},${exten} is in the dialplan and reads as ${label}`, () => {
      expect(contexts.get(context)?.has(exten)).toBe(true);
      expect(stageOf(place(direction, context, exten)).label).toBe(label);
    });
  }

  test('the two press-5 prompts read as the first and the second try', () => {
    const reads = [...read('inbound.conf').matchAll(/,Read\(([^)]*)\)/g)].map(
      (m) => m[1] as string,
    );
    expect(reads).toHaveLength(2);
    expect(
      reads.map(
        (data) =>
          stageOf(place('inbound', 'from-voipms', 's', 'Read', data)).label,
      ),
    ).toEqual(['press-5 prompt', 'press-5 prompt, second try']);
  });

  test('every toy reads as a toy', () => {
    const toys = [...(contexts.get('toybox') ?? [])].filter(
      (exten) => !exten.startsWith('_'),
    );
    expect(toys.length).toBeGreaterThan(0);
    for (const toy of toys) {
      expect(stageOf(place('handset', 'toybox', toy)).key).toBe('toy');
    }
  });

  test('the subroutines the stage looks past are dialplan contexts', () => {
    for (const context of SUBROUTINES) {
      expect(contexts.has(context)).toBe(true);
    }
  });

  test('every verdict kind is one the dialplan logs', () => {
    for (const kind of Object.keys(VERDICTS)) {
      expect(text).toContain(`Gosub(pbx-event,s,1(${kind}`);
    }
  });

  test('events.conf appends each kind to TRAIL', () => {
    expect(read('events.conf')).toMatch(/Set\(TRAIL=\$\{TRAIL\} \$\{ARG1\}\)/);
  });

  test('the troll agent is the endpoint the dialplan dials', () => {
    expect(read('pjsip.conf')).toContain(`[${AGENT_ENDPOINT}]`);
    expect(read('agent.conf')).toContain(`@${AGENT_ENDPOINT},`);
  });

  test("ari.conf's channelvars are the ones the board reads", () => {
    const line = /^channelvars\s*=\s*(.+)$/m.exec(read('ari.conf'))?.[1];
    expect(line?.split(',').map((v) => v.trim())).toEqual([...CHANNEL_VARS]);
  });
});

describe.skipIf(!present)('the board and its network policy', () => {
  interface HttpRule {
    method?: string;
    path?: string;
  }
  interface Policy {
    kind: string;
    metadata: { name: string };
    spec: {
      ingress?: {
        fromEndpoints?: { matchLabels?: Record<string, string> }[];
        toPorts?: { rules?: { http?: HttpRule[] } }[];
      }[];
    };
  }

  test('pbx-ari admits the board to exactly the paths it reads, as GET', () => {
    const docs = Bun.YAML.parse(
      readFileSync(join(PBX, 'switchboard.yaml'), 'utf8'),
    ) as Policy[];
    const policy = docs.find(
      (d) => d.kind === 'CiliumNetworkPolicy' && d.metadata.name === 'pbx-ari',
    );
    const fromBoard = (policy?.spec.ingress ?? []).filter((rule) =>
      rule.fromEndpoints?.some(
        (e) => e.matchLabels?.['app.kubernetes.io/name'] === 'switchboard',
      ),
    );
    expect(fromBoard.length).toBeGreaterThan(0);
    for (const rule of fromBoard) {
      for (const port of rule.toPorts ?? []) {
        expect(port.rules?.http).toEqual(
          [...ARI_LISTS, METRICS_PATH].map((path) => ({ method: 'GET', path })),
        );
      }
    }
  });
});
