const OUTBOUND_CALL_URL =
  'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call';
// The outbound-call endpoint answers once the callee picks up or the ring
// times out, so a person who takes a while to reach the phone still counts
// as a placed call. A read of a conversation is quick.
const CALL_TIMEOUT_MS = 75_000;
const TIMEOUT_MS = 10_000;

export type OutboundCallFailure =
  | 'timeout'
  | 'network'
  | 'http-error'
  | 'bad-response';

export class OutboundCallError extends Error {
  readonly reason: OutboundCallFailure;
  readonly httpStatus?: number;

  constructor(reason: OutboundCallFailure, httpStatus?: number) {
    super(`elevenlabs outbound-call failed: ${reason}`);
    this.name = 'OutboundCallError';
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export interface PlaceCallOptions {
  readonly apiKey: string;
  readonly agentId: string;
  readonly agentPhoneNumberId: string;
  readonly toNumber: string;
  readonly dynamicVariables: Record<string, string>;
  /** Sent as conversation_config_override when set. */
  readonly conversationConfigOverride?: Record<string, unknown>;
}

export interface OutboundCallResult {
  readonly conversationId: string;
  readonly sipCallId?: string;
}

interface OutboundCallResponse {
  success?: boolean;
  message?: string;
  conversation_id?: string;
  sip_call_id?: string;
}

/**
 * One request, bounded and never retried: a redial is the caller's decision,
 * not this function's. The thrown error never carries the request URL, body
 * or destination number, so a caller can log it as-is.
 */
export async function placeOutboundCall(
  opts: PlaceCallOptions,
): Promise<OutboundCallResult> {
  let res: Response;
  try {
    res = await fetch(OUTBOUND_CALL_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': opts.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: opts.agentId,
        agent_phone_number_id: opts.agentPhoneNumberId,
        // The trunk is voip.ms, which routes 11 digits and answers 404 to a
        // leading plus. The config and the allow-list stay E.164.
        to_number: opts.toNumber.replace(/^\+/, ''),
        conversation_initiation_client_data: {
          dynamic_variables: opts.dynamicVariables,
          ...(opts.conversationConfigOverride && {
            conversation_config_override: opts.conversationConfigOverride,
          }),
        },
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new OutboundCallError(timedOut ? 'timeout' : 'network');
  }
  if (!res.ok) throw new OutboundCallError('http-error', res.status);
  const body = (await res
    .json()
    .catch(() => null)) as OutboundCallResponse | null;
  if (!body?.success || !body.conversation_id) {
    throw new OutboundCallError('bad-response');
  }
  return { conversationId: body.conversation_id, sipCallId: body.sip_call_id };
}

const CONVERSATION_URL = 'https://api.elevenlabs.io/v1/convai/conversations';

export interface ConversationTurn {
  readonly role?: string;
  readonly message?: string | null;
  readonly time_in_call_secs?: number;
}

export interface Conversation {
  readonly status?: string;
  readonly transcript?: readonly ConversationTurn[];
  readonly metadata?: { readonly call_duration_secs?: number };
  readonly analysis?: {
    readonly evaluation_criteria_results?: Record<
      string,
      { readonly result?: string } | undefined
    >;
    readonly data_collection_results?: Record<
      string,
      { readonly value?: unknown } | undefined
    >;
  };
}

/** One bounded read of a conversation; any failure is null, never a throw. */
export async function fetchConversation(
  apiKey: string,
  conversationId: string,
): Promise<Conversation | null> {
  try {
    const res = await fetch(
      `${CONVERSATION_URL}/${encodeURIComponent(conversationId)}`,
      {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as Conversation;
  } catch {
    return null;
  }
}

const SIMULATE_TIMEOUT_MS = 240_000;

export interface SimulateOptions {
  readonly apiKey: string;
  readonly agentId: string;
  readonly dynamicVariables: Record<string, string>;
  /** The system prompt of the simulated callee. */
  readonly calleePrompt: string;
  readonly calleeFirstMessage: string;
  readonly turns: number;
}

interface SimulateResponse {
  simulated_conversation?: readonly ConversationTurn[];
}

/**
 * A text-only rehearsal: ElevenLabs plays the agent against a simulated
 * callee for `turns` turns and returns the transcript shaped like a finished
 * conversation. Null on any failure; nothing is dialled.
 */
export async function simulateConversation(
  opts: SimulateOptions,
): Promise<Conversation | null> {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(opts.agentId)}/simulate-conversation`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': opts.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          simulation_specification: {
            simulated_user_config: {
              first_message: opts.calleeFirstMessage,
              language: 'en',
              prompt: { prompt: opts.calleePrompt },
            },
            dynamic_variables: opts.dynamicVariables,
          },
          new_turns_limit: opts.turns,
        }),
        signal: AbortSignal.timeout(SIMULATE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as SimulateResponse;
    if (!Array.isArray(body.simulated_conversation)) return null;
    return { status: 'done', transcript: body.simulated_conversation };
  } catch {
    return null;
  }
}
