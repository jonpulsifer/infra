import { describe, expect, test } from 'bun:test';
import { authorizeExit } from '~/lib/exit-guard';

function req(method: string, headers: Record<string, string> = {}) {
  return new Request('https://hub.lolwtf.ca/api/exit', { method, headers });
}

const FORBIDDEN = { ok: false, status: 403 };

describe('authorizeExit', () => {
  test('allows a LAN caller', () => {
    const r = req('POST', { 'x-forwarded-for': '10.2.0.5' });
    expect(authorizeExit(r, {})).toEqual({ ok: true });
  });

  test('allows a tailnet caller', () => {
    const r = req('POST', { 'x-forwarded-for': '100.101.102.103' });
    expect(authorizeExit(r, {})).toEqual({ ok: true });
  });

  test('refuses a public caller', () => {
    const r = req('POST', { 'x-forwarded-for': '203.0.113.9' });
    expect(authorizeExit(r, {})).toEqual(FORBIDDEN);
  });

  test('refuses a public caller that forges a private first hop', () => {
    const r = req('POST', { 'x-forwarded-for': '10.2.0.5, 203.0.113.9' });
    expect(authorizeExit(r, {})).toEqual(FORBIDDEN);
  });

  test('refuses a request with no forwarded address', () => {
    expect(authorizeExit(req('POST'), {})).toEqual(FORBIDDEN);
  });

  test('refuses GET', () => {
    const r = req('GET', { 'x-forwarded-for': '10.2.0.5' });
    expect(authorizeExit(r, {})).toEqual({ ok: false, status: 405 });
  });

  test('refuses a cross-site browser request', () => {
    const r = req('POST', {
      'x-forwarded-for': '10.2.0.5',
      'sec-fetch-site': 'cross-site',
    });
    expect(authorizeExit(r, {})).toEqual(FORBIDDEN);
  });

  test('EXIT_ALLOWED_CIDRS overrides the defaults', () => {
    const env = { EXIT_ALLOWED_CIDRS: '192.168.1.0/24' };
    const lab = req('POST', { 'x-forwarded-for': '10.2.0.5' });
    const other = req('POST', { 'x-forwarded-for': '192.168.1.7' });
    expect(authorizeExit(lab, env)).toEqual(FORBIDDEN);
    expect(authorizeExit(other, env)).toEqual({ ok: true });
  });
});
