const OUTBOUND_CALL_URL =
  'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call';
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
  readonly reason: string;
  readonly source: string;
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
        to_number: opts.toNumber,
        conversation_initiation_client_data: {
          dynamic_variables: { reason: opts.reason, source: opts.source },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
