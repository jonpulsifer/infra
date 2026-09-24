// The move form reads its keys from the `supply.<KEY>` issues, never from the
// refusal sentence, so rewording the sentence cannot empty the form.
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
    expect(
      demandedKeys({
        code: 'NOT_FOUND',
        message: 'there is no Target with id 9d0f…',
      }),
    ).toEqual([]);

    // `deployApp` refuses a different Target with an issue at `target`, which
    // is not a key to supply.
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
