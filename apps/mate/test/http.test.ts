import { describe, expect, test } from 'bun:test';
import { Health } from '../src/health.ts';
import { Routes } from '../src/http.ts';

describe('Routes', () => {
  test('dispatches by path, and a removed route is 404 again', async () => {
    const routes = new Routes();
    const health = new Health();
    health.connected = true;
    routes.set('/healthz', (request) => health.fetch(request));
    routes.set('/alertmanager', async () => new Response('posted'));
    const get = (path: string) =>
      routes.fetch(new Request(`http://mate${path}`));
    expect((await get('/healthz')).status).toBe(200);
    expect(await (await get('/alertmanager')).text()).toBe('posted');
    expect((await get('/')).status).toBe(404);
    expect((await get('/alertmanager/extra')).status).toBe(404);
    routes.set('/alertmanager', null);
    expect((await get('/alertmanager')).status).toBe(404);
  });
});
