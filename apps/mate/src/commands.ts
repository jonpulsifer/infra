import type { ApplicationCommandsAPI } from '@discordjs/core';
import {
  ApplicationCommandType,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from 'discord-api-types/v10';
import type { Log } from './log.ts';

export type GlobalCommands = Pick<
  ApplicationCommandsAPI,
  'getGlobalCommands' | 'bulkOverwriteGlobalCommands'
>;
export type GuildCommands = Pick<
  ApplicationCommandsAPI,
  'bulkOverwriteGuildCommands'
>;

/** The guild's slash commands: the voice pair. Overwritten whole at every READY. */
export const GUILD_COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
  {
    type: ApplicationCommandType.ChatInput,
    name: 'join',
    description: 'Join the voice channel you are in',
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: 'leave',
    description: 'Leave the voice channel',
  },
];

export async function registerGuildCommands(
  api: GuildCommands,
  applicationId: string,
  guildId: string,
  log: Log,
): Promise<void> {
  await api.bulkOverwriteGuildCommands(applicationId, guildId, GUILD_COMMANDS);
  log.info('guild commands registered', {
    guildId,
    names: GUILD_COMMANDS.map((command) => command.name),
  });
}

// Global commands belong to the application, so any a previous user of this
// token registered stay in the guild until overwritten. mate has none.
export async function clearGlobalCommands(
  api: GlobalCommands,
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
