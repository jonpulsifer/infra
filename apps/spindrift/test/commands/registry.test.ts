/**
 * The registry is the dispatch surface, so this file asserts the two things
 * that make it one (§21, and the plan's "one dispatch endpoint generated from
 * the command registry"):
 *
 * 1. **Every exported command is registered.** An export absent from the
 *    registry is a command the browser could never call, and the generated
 *    endpoint would silently not have it. `registry.ts` also refuses to
 *    type-check in that case; this test is the version that fails loudly
 *    without reading the compiler's output.
 * 2. **Every registered name is an exported command.** A route that is not a
 *    command is exactly what §21 refuses to grow, and the only way one could
 *    appear is an entry here pointing at something else.
 *
 * Neither assertion needs a database: the failure paths under test refuse
 * before a handler runs, and the context below proves it by throwing if
 * anything reaches for the connection.
 */
import { describe, expect, test } from 'bun:test';
import * as commandModule from '../../src/commands/index.ts';
import {
  commandNames,
  commandRegistry,
  dispatch,
  isCommandName,
} from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import type { Database } from '../../src/db/client.ts';

/** Reaching for any of these is the failure this file is watching for. */
function unreachable(what: string): never {
  throw new Error(`a refused command reached the ${what}`);
}

const noDatabase = new Proxy(
  {},
  {
    get: () => unreachable('database'),
  },
) as Database;

const noAdapters: AdapterRegistry = {
  deploy: () => unreachable('deploy adapter'),
  build: () => unreachable('build adapter'),
  store: () => unreachable('secret store'),
};

const context: CommandContext = {
  principal: { id: crypto.randomUUID(), displayName: 'Operator' },
  clock: { now: () => unreachable('clock') },
  db: noDatabase,
  adapters: noAdapters,
};

/**
 * Every value `src/commands/index.ts` exports. That file's contract is that
 * each of them is a command — which is why this needs no allowlist, and why a
 * newly exported command cannot slip past by not being mentioned here.
 */
const exported = Object.entries(commandModule);

describe('the command surface and the registry are the same set', () => {
  test('index.ts exports commands and nothing else', () => {
    expect(exported.length).toBeGreaterThan(0);
    for (const [name, value] of exported) {
      expect(typeof value).toBe('function');
      expect(name).not.toBe('');
    }
  });

  test('every exported command is registered under its own name', () => {
    const exportedNames = exported.map(([name]) => name).sort();
    const registeredNames = Object.keys(commandRegistry).sort();
    expect(registeredNames).toEqual(exportedNames);
  });

  test('each registry entry points at the command it names', () => {
    for (const [name, value] of exported) {
      const descriptor = (
        commandRegistry as Record<string, { handler: unknown } | undefined>
      )[name];
      expect(descriptor).toBeDefined();
      expect(descriptor?.handler).toBe(value);
    }
  });

  test('each registry entry carries an input schema', () => {
    for (const descriptor of Object.values(commandRegistry)) {
      expect(typeof descriptor.input.safeParse).toBe('function');
    }
  });

  test('the generated name list is the registry keys', () => {
    expect(Object.keys(commandRegistry).sort()).toEqual(
      [...commandNames].sort(),
    );
    for (const name of commandNames) {
      expect(isCommandName(name)).toBe(true);
    }
  });
});

describe('dispatch refuses what the registry does not back', () => {
  test('an unknown name is a refusal, not a thrown error', async () => {
    const result = await dispatch('deployTheWholeFleet', {}, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('UNKNOWN_COMMAND');
    expect(result.failure.message).toContain('deployTheWholeFleet');
  });

  test('isCommandName rejects a name that is only a property of Object', () => {
    expect(isCommandName('toString')).toBe(false);
    expect(isCommandName('constructor')).toBe(false);
  });

  test('invalid input is refused with the field that was wrong', async () => {
    const result = await dispatch(
      'createApp',
      { name: 'UPPERCASE', sourceKind: 'repo', repoUrl: 'nonsense' },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    const paths = (result.failure.issues ?? []).map((issue) => issue.path);
    expect(paths).toContain('name');
    expect(paths).toContain('repoUrl');
  });

  test('an input naming no known source kind is refused', async () => {
    const result = await dispatch(
      'createApp',
      { name: 'thing', sourceKind: 'ftp' },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
  });
});
