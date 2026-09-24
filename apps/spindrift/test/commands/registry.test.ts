/**
 * What `dispatch` does with a name and a body before any handler runs.
 * `unreachableContext` throws on database access, so a refusal proves no
 * handler ran.
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
 * The registry's `satisfies` clause accepts any command under any name, so the
 * handler's binding name is the only check that an entry runs its own command.
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
    // Only the auto-deploy pass names a commit; from a browser it could deploy
    // an unreviewed ref, so the schema omits it and `.strict()` refuses it.
    const result = await dispatch(
      'deployApp',
      { name: 'invoices', commit: 'f'.repeat(40) },
      context,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    // `.strict()` rejects the object itself, so the key is in the message, with
    // no path.
    expect(
      result.failure.issues?.some((issue) => issue.message.includes('commit')),
    ).toBe(true);
  });

  test('the same call without a commit reaches the handler', async () => {
    // Past validation, the handler throws in `unreachableContext`.
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
