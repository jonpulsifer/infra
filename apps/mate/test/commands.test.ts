import { describe, expect, test } from 'bun:test';
import { clearGlobalCommands } from '../src/commands.ts';
import { silentLog } from '../src/log.ts';

function fakeCommands(names: string[]) {
  const calls: unknown[] = [];
  return {
    calls,
    api: {
      getGlobalCommands: async () =>
        names.map((name, i) => ({ id: `${i}`, name })) as never,
      bulkOverwriteGlobalCommands: async (_id: string, body: unknown) => {
        calls.push(body);
        return [] as never;
      },
    },
  };
}

describe('slash-command cleanup at first connect', () => {
  test("overwrites the application's global commands with none and reports what went", async () => {
    const { api, calls } = fakeCommands(['help', 'status', 'ask']);
    const deleted = await clearGlobalCommands(api, 'app', silentLog);
    expect(deleted).toEqual(['ask', 'help', 'status']);
    expect(calls).toEqual([[]]);
  });

  test('does not write when there is nothing to delete', async () => {
    const { api, calls } = fakeCommands([]);
    expect(await clearGlobalCommands(api, 'app', silentLog)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
