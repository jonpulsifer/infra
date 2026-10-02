/** What pi stored for a session, read through a harness that never runs a task. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Message } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openStorage } from '@repo/pi-store-postgres';
import type { SQL } from 'bun';

/** The root conversation's messages, oldest first. */
export async function transcript(
  sql: SQL,
  sessionId: string,
): Promise<Message[]> {
  const harness = await Harness.open(
    await openStorage(sql, sessionId),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 1_000, undefined, BACKGROUND_CONTEXT);
    return [...page.items].reverse().flatMap((entry) => entry.model ?? []);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

export function toolText(messages: Message[], toolCallId: string): string {
  const result = messages.find(
    (message) =>
      message.role === 'toolResult' && message.toolCallId === toolCallId,
  );
  if (result?.role !== 'toolResult') return '';
  return result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('');
}

/** The model and thinking level the root conversation is configured with. */
export async function storedAgent(sql: SQL, sessionId: string) {
  const harness = await Harness.open(
    await openStorage(sql, sessionId),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const { model, thinkingLevel } = await root.agent(BACKGROUND_CONTEXT);
    return { model, thinkingLevel };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}
