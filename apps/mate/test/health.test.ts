import { describe, expect, test } from 'bun:test';
import { Health } from '../src/health.ts';

describe('/healthz', () => {
  test('is 503 until the gateway is up and again when it drops', async () => {
    const health = new Health();
    const probe = () => health.fetch(new Request('http://mate/healthz'));
    expect(probe().status).toBe(503);
    health.connected = true;
    expect(probe().status).toBe(200);
    expect(await probe().text()).toBe('ok');
    health.connected = false;
    expect(probe().status).toBe(503);
    expect(health.fetch(new Request('http://mate/')).status).toBe(404);
  });
});
