import type { Webhook } from './types';

// The outgoing request a user composes, the conversions between its key/value
// fields and raw JSON, and the one place that decides what goes on the wire.

export type FieldMode = 'pairs' | 'raw';

export interface FieldPair {
  id: string;
  key: string;
  value: string;
}

export interface RequestDraft {
  method: string;
  url: string;
  headerMode: FieldMode;
  headerPairs: FieldPair[];
  rawHeaders: string;
  bodyMode: FieldMode;
  bodyPairs: FieldPair[];
  rawBody: string;
}

export interface OutgoingRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export type DraftResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

const JSON_CONTENT_TYPE = 'application/json';

// A resend recomputes these, since they describe the captured request.
const RESEND_STRIPPED_HEADERS = new Set(['content-type', 'content-length']);

export function emptyPair(prefix: string, index = 0): FieldPair {
  return { id: `${prefix}-${index}`, key: '', value: '' };
}

function withFallbackRow(pairs: FieldPair[], prefix: string): FieldPair[] {
  return pairs.length > 0 ? pairs : [emptyPair(prefix)];
}

export function pairsToRecord(pairs: FieldPair[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const trimmed = key.trim();
    if (trimmed) {
      record[trimmed] = value;
    }
  }
  return record;
}

export function recordToPairs(
  record: Record<string, unknown>,
  prefix: string,
): FieldPair[] {
  const pairs = Object.entries(record)
    .filter(([key]) => key.trim().length > 0)
    .map(([key, value], index) => ({
      id: `${prefix}-${index}`,
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  return withFallbackRow(pairs, prefix);
}

export function pairsToJson(pairs: FieldPair[]): string {
  const record = pairsToRecord(pairs);
  return JSON.stringify(record, null, 2);
}

// A value that parses as JSON is kept parsed, and any other stays a string.
// null when no field has a key.
export function bodyPairsToObject(
  pairs: FieldPair[],
): Record<string, unknown> | null {
  const object: Record<string, unknown> = {};
  let hasContent = false;
  for (const { key, value } of pairs) {
    const trimmed = key.trim();
    if (!trimmed) {
      continue;
    }
    hasContent = true;
    try {
      object[trimmed] = JSON.parse(value);
    } catch {
      object[trimmed] = value;
    }
  }
  return hasContent ? object : null;
}

export function bodyPairsToJson(pairs: FieldPair[]): string {
  const object = bodyPairsToObject(pairs);
  return object ? JSON.stringify(object, null, 2) : '{}';
}

export function headersFromJson(raw: string): DraftResult<FieldPair[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (error) {
    return {
      ok: false,
      error: describe(error, 'Headers must be valid JSON'),
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Headers must be a JSON object' };
  }
  if (Object.values(parsed).some((value) => typeof value !== 'string')) {
    return { ok: false, error: 'Header values must be strings' };
  }
  return { ok: true, value: recordToPairs(parsed, 'header') };
}

export function bodyFromJson(raw: string): DraftResult<FieldPair[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch (error) {
    return { ok: false, error: describe(error, 'Body must be valid JSON') };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: 'Body must be a JSON object to switch back to fields',
    };
  }
  return { ok: true, value: recordToPairs(parsed, 'body') };
}

export function draftFromWebhook(webhook: Webhook): RequestDraft {
  const replayHeaders = Object.fromEntries(
    Object.entries(webhook.headers).filter(
      ([key]) => !RESEND_STRIPPED_HEADERS.has(key.toLowerCase()),
    ),
  );

  let bodyPairs: FieldPair[] = [emptyPair('body')];
  if (webhook.body) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(webhook.body);
    } catch {
      parsed = null;
    }
    bodyPairs = isPlainObject(parsed)
      ? recordToPairs(parsed, 'body')
      : [{ id: 'body-0', key: '', value: webhook.body }];
  }

  return {
    method: webhook.method,
    url: webhook.url,
    headerMode: 'pairs',
    headerPairs: recordToPairs(replayHeaders, 'header'),
    rawHeaders: JSON.stringify(webhook.headers, null, 2),
    bodyMode: 'pairs',
    bodyPairs,
    rawBody: webhook.body ?? '{}',
  };
}

export function emptyDraft(): RequestDraft {
  return {
    method: 'POST',
    url: '',
    headerMode: 'pairs',
    headerPairs: [emptyPair('header')],
    rawHeaders: '{}',
    bodyMode: 'pairs',
    bodyPairs: [emptyPair('body')],
    rawBody: '{}',
  };
}

export function buildRequest(
  draft: RequestDraft,
): DraftResult<OutgoingRequest> {
  const url = draft.url.trim();
  if (!url) {
    return { ok: false, error: 'Please enter a URL' };
  }

  const headersResult = resolveHeaders(draft);
  if (!headersResult.ok) {
    return headersResult;
  }
  const headers = headersResult.value;

  const method = draft.method.toUpperCase();
  if (!METHODS_WITH_BODY.has(method)) {
    return { ok: true, value: { method, url, headers, body: null } };
  }

  const bodyResult = resolveBody(draft);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  const body = bodyResult.value;
  if (body !== null && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = JSON_CONTENT_TYPE;
  }

  return { ok: true, value: { method, url, headers, body } };
}

function resolveHeaders(
  draft: RequestDraft,
): DraftResult<Record<string, string>> {
  if (draft.headerMode === 'pairs') {
    return { ok: true, value: pairsToRecord(draft.headerPairs) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.rawHeaders || '{}');
  } catch (error) {
    return {
      ok: false,
      error: describe(error, 'Headers must be a valid JSON object'),
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Headers must be a valid JSON object' };
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const trimmed = key.trim();
    if (trimmed) {
      headers[trimmed] = String(value);
    }
  }
  return { ok: true, value: headers };
}

function resolveBody(draft: RequestDraft): DraftResult<string | null> {
  if (draft.bodyMode === 'pairs') {
    const object = bodyPairsToObject(draft.bodyPairs);
    return { ok: true, value: object ? JSON.stringify(object) : null };
  }

  const raw = draft.rawBody.trim();
  if (!raw || raw === '{}') {
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: JSON.stringify(JSON.parse(raw)) };
  } catch (error) {
    return { ok: false, error: describe(error, 'Body must be valid JSON') };
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}
