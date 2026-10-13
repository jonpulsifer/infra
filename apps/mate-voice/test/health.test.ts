import { describe, expect, test } from 'bun:test';
import { Health } from '../src/health.ts';

describe('/healthz', () => {
  test('is 503 until mate is linked', async () => {
    const health = new Health();
    const probe = () => health.fetch(new Request('http://voice/healthz'));
    expect(probe().status).toBe(503);
    health.linked = true;
    expect(await probe().text()).toBe('ok');
    expect(health.fetch(new Request('http://voice/')).status).toBe(404);
  });
});
