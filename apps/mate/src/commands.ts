import type { ApplicationCommandsAPI } from '@discordjs/core';
import type { Log } from './log.ts';

type Commands = Pick<
  ApplicationCommandsAPI,
  'getGlobalCommands' | 'bulkOverwriteGlobalCommands'
>;

// Global commands belong to the application, so any a previous user of this
// token registered stay in the guild until overwritten. mate has none.
export async function clearGlobalCommands(
  api: Commands,
  applicationId: string,
  log: Log,
): Promise<string[]> {
  const existing = await api.getGlobalCommands(applicationId);
  const names = existing.map((command) => command.name).sort();
  if (names.length > 0) {
    await api.bulkOverwriteGlobalCommands(applicationId, []);
  }
  log.info('global commands cleared', {
    applicationId,
    deleted: names.length,
    names,
  });
  return names;
}
