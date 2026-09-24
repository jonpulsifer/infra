import { afterEach, describe, expect, test } from 'bun:test';
import { OutboundCallError, placeOutboundCall } from '../src/elevenlabs.ts';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const opts = {
  apiKey: 'a-secret-key',
  agentId: 'agent_1',
  agentPhoneNumberId: 'phnum_1',
  toNumber: '+19025551234',
  reason: 'testing',
  source: 'ring',
};

describe('placeOutboundCall', () => {
  test('posts the documented shape and returns the conversation id', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url: String(url), init };
      return Response.json({
        success: true,
        conversation_id: 'conv_1',
        sip_call_id: 'sip_1',
      });
    }) as unknown as typeof fetch;

    const result = await placeOutboundCall(opts);
    expect(result).toEqual({ conversationId: 'conv_1', sipCallId: 'sip_1' });
    expect(sent?.url).toBe(
      'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call',
    );
    expect(sent?.init.method).toBe('POST');
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('a-secret-key');
    expect(JSON.parse(String(sent?.init.body))).toEqual({
      agent_id: 'agent_1',
      agent_phone_number_id: 'phnum_1',
      to_number: '+19025551234',
      conversation_initiation_client_data: {
        dynamic_variables: { reason: 'testing', source: 'ring' },
      },
    });
  });

  test('a non-2xx response is an http-error, and the request runs once', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('bad gateway', { status: 502 });
    }) as unknown as typeof fetch;
    const failure = await placeOutboundCall(opts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OutboundCallError);
    expect((failure as OutboundCallError).reason).toBe('http-error');
    expect((failure as OutboundCallError).httpStatus).toBe(502);
    expect(calls).toBe(1);
  });

  test('success:false in a 200 response is a bad-response', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        success: false,
        message: 'no minutes left',
      })) as unknown as typeof fetch;
    const failure = await placeOutboundCall(opts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OutboundCallError);
    expect((failure as OutboundCallError).reason).toBe('bad-response');
  });

  test('a timeout is reported as such', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('The operation timed out.'), {
        name: 'TimeoutError',
      });
    }) as unknown as typeof fetch;
    const failure = await placeOutboundCall(opts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OutboundCallError);
    expect((failure as OutboundCallError).reason).toBe('timeout');
  });

  test('a thrown error never carries the URL, body or destination number', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network is unreachable');
    }) as unknown as typeof fetch;
    const failure = (await placeOutboundCall(opts).catch(
      (e: unknown) => e,
    )) as OutboundCallError;
    expect(failure.message).not.toContain(opts.toNumber);
    expect(failure.message).not.toContain('api.elevenlabs.io');
    expect(failure.message).not.toContain(opts.apiKey);
  });

  test('every request carries an abort signal', async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Response.json({ success: true, conversation_id: 'c' });
    }) as unknown as typeof fetch;
    await placeOutboundCall(opts);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
