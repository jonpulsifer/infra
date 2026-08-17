/**
 * What `dispatch` does with a name and a body before any handler runs (§21).
 *
 * The registry is the only list of commands, so "every command is registered"
 * and "every registered name is a command" are no longer two sets to compare:
 * the first is a handler nobody imported into `registry.ts`, and the second
 * cannot be written, because the registry's `satisfies` clause refuses an entry
 * whose handler is not a `Command`. What is left to assert at run time is the
 * part the type system cannot reach — that the handler under a name is the
 * command of *that* name, an untrusted string arriving from a browser, and
 * what the surface does with one it does not recognise.
 *
 * No database anywhere: every path under test refuses before a handler runs,
 * and `unreachableContext` proves it by throwing if anything reaches for the
 * connection.
 */
import { describe, expect, test } from 'bun:test';
import {
  commandRegistry,
  dispatch,
  isCommandName,
} from '../../src/commands/registry.ts';
import { unreachableContext } from '../harness/context.ts';

const context = await unreachableContext();

/**
 * The one thing collapsing to a single list gave up, put back.
 *
 * `AnyCommandDescriptor` is `CommandDescriptor<any, any>`, so the `satisfies`
 * clause on the registry constrains an entry to *a* command and says nothing
 * about *which* — `setAppZone: { input: setAppZoneInput, handler: setAppBuildRoute }`
 * type-checks. Every handler is `export const <name>: Command<…>`, so the
 * binding's own name is the assertable identity the types cannot carry, and a
 * mis-wired entry names itself here instead of quietly running the wrong act
 * for a browser that asked for the right one.
 */
test('the handler under each name is the command of that name', () => {
  for (const [name, descriptor] of Object.entries(commandRegistry)) {
    expect(descriptor.handler.name).toBe(name);
  }
});

describe('dispatch refuses what the registry does not back', () => {
  test('an unknown name is a refusal, not a thrown error', async () => {
    const result = await dispatch('deployTheWholeFleet', {}, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('UNKNOWN_COMMAND');
    expect(result.failure.message).toContain('deployTheWholeFleet');
  });

  test('a browser cannot name the commit deployApp builds', async () => {
    // `commit` is how §15's dispatcher tells `deployApp` which commit a pass
    // adopted, and adopting is the only thing that makes a commit
    // authoritative. A caller naming one directly would be asking Spindrift to
    // stage, build and place an arbitrary ref — an unmerged branch, a fork's
    // head — through a path with no review and no admission gate of its own.
    // So the registered schema is the command's input minus that field, and
    // `.strict()` makes naming it a refusal rather than a silent drop.
    const result = await dispatch(
      'deployApp',
      { name: 'invoices', commit: 'f'.repeat(40) },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    // The whole object is what `.strict()` rejects, so the issue carries no
    // field path — the key it names is in the sentence.
    expect(
      result.failure.issues?.some((issue) => issue.message.includes('commit')),
    ).toBe(true);
    // `unreachableContext` throws on any database access, so reaching this line
    // is itself the proof that no handler ran.
  });

  test('the same call without a commit reaches the handler', async () => {
    // The guard above has to be about the field and not about the command:
    // every other caller of `deployApp` must still dispatch. This one gets past
    // validation and dies in `unreachableContext`, which is exactly far enough
    // to prove the schema admitted it.
    expect(
      dispatch('deployApp', { name: 'invoices' }, context),
    ).rejects.toThrow();
  });

  test('isCommandName rejects a name that is only a property of Object', () => {
    expect(isCommandName('toString')).toBe(false);
    expect(isCommandName('constructor')).toBe(false);
  });

  test('invalid input is refused with the field that was wrong', async () => {
    const result = await dispatch(
      'completeCreationDraft',
      { id: 'not-a-uuid', revision: -1 },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    const paths = (result.failure.issues ?? []).map((issue) => issue.path);
    expect(paths).toContain('id');
    expect(paths).toContain('revision');
  });

  test('an input carrying an unknown field is refused', async () => {
    const result = await dispatch(
      'startCreationDraft',
      { mystery: true },
      context,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
  });
});
