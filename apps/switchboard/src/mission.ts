import { type Conversation, fetchConversation } from './elevenlabs.ts';

export const DEFAULT_OBJECTIVE =
  'Get them to say the keyword out loud, without ever saying it yourself.';
export const OBJECTIVE_MAX_LEN = 300;
export const NAME_MAX_LEN = 40;

const KEYWORD = /^[A-Za-z' -]{1,40}$/;

/** The trimmed keyword, or undefined when it is not 1-40 letters, spaces, hyphens or apostrophes. */
export function parseKeyword(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const keyword = raw.trim();
  return KEYWORD.test(keyword) && /[A-Za-z]/.test(keyword)
    ? keyword
    : undefined;
}

export function defaultName(target: string): string {
  return target.charAt(0).toUpperCase() + target.slice(1);
}

export interface MissionResult {
  readonly won: boolean;
  readonly turn?: number;
  readonly secondsToWin?: number;
  readonly agentSaidFirst: boolean;
  readonly fairPlay?: string;
  readonly keywordWon?: string;
  readonly winningLine?: string;
  readonly howItHappened?: string;
  readonly durationSecs?: number;
}

function keywordPattern(keyword: string): RegExp {
  const body = keyword
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('\\s+');
  // A plural counts: berry and berries, fox and foxes, otter and otters.
  const plural = body.endsWith('y')
    ? `${body.slice(0, -1)}(?:y|ies)`
    : `${body}(?:es|s)?`;
  return new RegExp(`(?<![\\p{L}\\p{N}])${plural}(?![\\p{L}\\p{N}])`, 'iu');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Scores a finished conversation. The first turn to contain the keyword
 * decides it: a user turn wins, an agent turn means Earl said it first.
 */
export function scoreConversation(
  conversation: Conversation,
  keyword: string,
): MissionResult {
  const pattern = keywordPattern(keyword);
  const transcript = conversation.transcript ?? [];
  let won = false;
  let agentSaidFirst = false;
  let turn: number | undefined;
  let secondsToWin: number | undefined;
  for (const [index, entry] of transcript.entries()) {
    if (!entry.message || !pattern.test(entry.message)) continue;
    if (entry.role === 'user') {
      won = true;
      turn = index;
      secondsToWin = entry.time_in_call_secs;
    } else if (entry.role === 'agent') {
      agentSaidFirst = true;
    } else {
      continue;
    }
    break;
  }
  const criteria = conversation.analysis?.evaluation_criteria_results;
  const data = conversation.analysis?.data_collection_results;
  return {
    won,
    turn,
    secondsToWin,
    agentSaidFirst,
    fairPlay: text(criteria?.fair_play?.result),
    keywordWon: text(criteria?.keyword_won?.result),
    winningLine: text(data?.winning_line?.value),
    howItHappened: text(data?.how_it_happened?.value),
    durationSecs: conversation.metadata?.call_duration_secs,
  };
}

export const POLL_INTERVAL_MS = 5_000;
// 7 minutes: the call itself is capped at 5.
export const POLL_LIMIT = (7 * 60_000) / POLL_INTERVAL_MS;

/**
 * Polls until ElevenLabs reports the conversation done or failed, then
 * scores it. Null when the poll limit runs out first. A failed read keeps
 * polling.
 */
export async function pollAndScore(opts: {
  readonly apiKey: string;
  readonly conversationId: string;
  readonly keyword: string;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<MissionResult | null> {
  for (let poll = 0; poll < POLL_LIMIT; poll++) {
    const conversation = await fetchConversation(
      opts.apiKey,
      opts.conversationId,
    );
    if (conversation?.status === 'done' || conversation?.status === 'failed') {
      return scoreConversation(conversation, opts.keyword);
    }
    await opts.sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export const MAX_RESULTS = 50;

export type StoredMission = MissionResult | 'pending';

/** The newest MAX_RESULTS missions by conversation id, oldest evicted first. */
export class MissionStore {
  private readonly entries = new Map<string, StoredMission>();

  set(conversationId: string, value: StoredMission): void {
    this.entries.delete(conversationId);
    this.entries.set(conversationId, value);
    while (this.entries.size > MAX_RESULTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(conversationId: string): StoredMission | undefined {
    return this.entries.get(conversationId);
  }
}
