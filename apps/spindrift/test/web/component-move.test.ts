/**
 * How the move form learns which keys it has to ask for (ticket 121, §10).
 *
 * §10's refusal names the keys twice: in the sentence a person reads, and as
 * `issues` at `supply.<KEY>` (`src/commands/components/place.ts:107-124`). The
 * form is built from the second, and this pins that — a form assembled by
 * splitting the sentence would break the day somebody improves the wording,
 * and it would break silently, as a move whose demand renders as an empty
 * form.
 *
 * Against `demandedKeys` rather than the mounted screen, for the reason
 * `test/web/component-create.test.ts` states: reaching it there means pressing
 * Move, and `test/harness/dom.ts` simulates no clicks.
 */
import { describe, expect, test } from 'bun:test';
import { demandSentence } from '../../src/commands/config/migration.ts';
import { demandedKeys } from '../../src/web/views/apps/workspace.tsx';

describe('the keys a refused move demands', () => {
  test('are read off the issues, in the order the refusal named them', () => {
    const demanded = demandedKeys({
      code: 'NOT_DEPLOYABLE',
      message: demandSentence(['API_KEY', 'TOKEN'], 'vessel-a/cloudrun'),
      issues: [
        {
          path: 'supply.API_KEY',
          message: 'must be supplied to finish the move',
        },
        {
          path: 'supply.TOKEN',
          message: 'must be supplied to finish the move',
        },
      ],
    });

    expect(demanded).toEqual(['API_KEY', 'TOKEN']);
  });

  test('are empty for every refusal that is not a demand', () => {
    // The empty case is the test: a move refused for a reason that is not a
    // demand — a Target that is gone, a store that will not write — is a
    // sentence to read, and rendering it as a form with no fields would be the
    // screen asking a question nobody was asked.
    expect(
      demandedKeys({
        code: 'NOT_FOUND',
        message: 'there is no Target with id 9d0f…',
      }),
    ).toEqual([]);

    // An issue against another field is another field's. `deployApp` refuses a
    // deploy that names a different Target with exactly one
    // (`src/commands/apps/deploy.ts:386-391`), and that is not a key to supply.
    expect(
      demandedKeys({
        code: 'INVALID_INPUT',
        message: "Component 'web' is placed elsewhere",
        issues: [
          { path: 'target', message: 'disagrees with the existing placement' },
        ],
      }),
    ).toEqual([]);
  });
});
