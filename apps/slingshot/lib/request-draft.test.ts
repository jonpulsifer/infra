import { describe, expect, test } from 'bun:test';
import {
  bodyFromJson,
  bodyPairsToObject,
  buildRequest,
  draftFromWebhook,
  emptyDraft,
  headersFromJson,
  pairsToRecord,
  type RequestDraft,
  recordToPairs,
} from './request-draft';
import type { Webhook } from './types';

function draft(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return { ...emptyDraft(), url: 'https://example.com/hook', ...overrides };
}

function pairs(...entries: [string, string][]) {
  return entries.map(([key, value], i) => ({ id: `p-${i}`, key, value }));
}

describe('pairsToRecord', () => {
  test('trims keys and drops blank ones', () => {
    expect(
      pairsToRecord(pairs(['  X-Token ', 'abc'], ['', 'ignored'])),
    ).toEqual({ 'X-Token': 'abc' });
  });

  test('keeps blank values - an empty header is still a header', () => {
    expect(pairsToRecord(pairs(['X-Empty', '']))).toEqual({ 'X-Empty': '' });
  });
});

describe('recordToPairs', () => {
  test('always yields at least one editable row', () => {
    expect(recordToPairs({}, 'header')).toEqual([
      { id: 'header-0', key: '', value: '' },
    ]);
  });

  test('stringifies non-string values', () => {
    expect(recordToPairs({ n: 1, b: true }, 'body')).toEqual([
      { id: 'body-0', key: 'n', value: '1' },
      { id: 'body-1', key: 'b', value: 'true' },
    ]);
  });
});

describe('bodyPairsToObject', () => {
  test('parses values that are JSON and keeps the rest as strings', () => {
    expect(
      bodyPairsToObject(
        pairs(['count', '3'], ['nested', '{"a":1}'], ['name', 'hello']),
      ),
    ).toEqual({ count: 3, nested: { a: 1 }, name: 'hello' });
  });

  test('is null when every key is blank', () => {
    expect(bodyPairsToObject(pairs(['', 'x']))).toBeNull();
  });
});

describe('headersFromJson', () => {
  test('rejects malformed JSON', () => {
    expect(headersFromJson('{oops').ok).toBe(false);
  });

  test('rejects arrays', () => {
    expect(headersFromJson('[]').ok).toBe(false);
  });

  test('rejects non-string values', () => {
    const result = headersFromJson('{"X-Count": 2}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('strings');
    }
  });

  test('accepts a flat string object', () => {
    const result = headersFromJson('{"X-Token":"abc"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({ key: 'X-Token', value: 'abc' });
    }
  });
});

describe('bodyFromJson', () => {
  test('rejects a non-object payload', () => {
    expect(bodyFromJson('[1,2]').ok).toBe(false);
  });

  test('accepts an object', () => {
    expect(bodyFromJson('{"a":1}').ok).toBe(true);
  });
});

describe('buildRequest', () => {
  test('refuses an empty URL', () => {
    const result = buildRequest(draft({ url: '   ' }));
    expect(result.ok).toBe(false);
  });

  test('omits the body for methods that cannot carry one', () => {
    const result = buildRequest(
      draft({ method: 'GET', bodyPairs: pairs(['a', '1']) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBeNull();
    }
  });

  test('adds a JSON content type only when a body is present', () => {
    const withBody = buildRequest(
      draft({ method: 'POST', bodyPairs: pairs(['a', '1']) }),
    );
    const withoutBody = buildRequest(draft({ method: 'POST' }));

    expect(withBody.ok && withBody.value.headers['Content-Type']).toBe(
      'application/json',
    );
    expect(withoutBody.ok && withoutBody.value.body).toBeNull();
    expect(
      withoutBody.ok && withoutBody.value.headers['Content-Type'],
    ).toBeUndefined();
  });

  test('does not override a content type the user set, whatever its case', () => {
    const result = buildRequest(
      draft({
        method: 'POST',
        headerPairs: pairs(['content-type', 'text/plain']),
        bodyPairs: pairs(['a', '1']),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headers['content-type']).toBe('text/plain');
      expect(result.value.headers['Content-Type']).toBeUndefined();
    }
  });

  test('uppercases the method', () => {
    const result = buildRequest(draft({ method: 'post' }));
    expect(result.ok && result.value.method).toBe('POST');
  });

  test('raw mode rejects malformed body JSON', () => {
    const result = buildRequest(
      draft({ method: 'POST', bodyMode: 'raw', rawBody: '{nope' }),
    );
    expect(result.ok).toBe(false);
  });

  test('raw mode treats an empty object as no body', () => {
    const result = buildRequest(
      draft({ method: 'POST', bodyMode: 'raw', rawBody: '{}' }),
    );
    expect(result.ok && result.value.body).toBeNull();
  });

  test('raw headers stringify non-string values', () => {
    const result = buildRequest(
      draft({ headerMode: 'raw', rawHeaders: '{"X-Retry": 3}' }),
    );
    expect(result.ok && result.value.headers['X-Retry']).toBe('3');
  });
});

describe('draftFromWebhook', () => {
  const captured: Webhook = {
    id: 'w1',
    method: 'PUT',
    url: 'https://example.com/in',
    headers: {
      'Content-Type': 'application/json',
      'content-length': '12',
      'X-Source': 'github',
    },
    body: '{"action":"opened"}',
    timestamp: 1,
    direction: 'incoming',
  };

  test('drops content headers so they get recomputed', () => {
    const result = draftFromWebhook(captured);
    const keys = result.headerPairs.map((p) => p.key);
    expect(keys).toEqual(['X-Source']);
  });

  test('expands a JSON object body into fields', () => {
    const result = draftFromWebhook(captured);
    expect(result.bodyPairs).toEqual([
      { id: 'body-0', key: 'action', value: 'opened' },
    ]);
  });

  test('keeps a non-JSON body intact', () => {
    const result = draftFromWebhook({ ...captured, body: 'plain text' });
    expect(result.bodyPairs).toEqual([
      { id: 'body-0', key: '', value: 'plain text' },
    ]);
  });

  test('round-trips into a sendable request', () => {
    const result = buildRequest(draftFromWebhook(captured));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe('PUT');
      expect(result.value.headers['X-Source']).toBe('github');
      expect(JSON.parse(result.value.body ?? '{}')).toEqual({
        action: 'opened',
      });
    }
  });
});
