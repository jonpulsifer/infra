import { describe, expect, test } from 'bun:test';
import { operationNames } from '../src/operations.ts';
import { Places, parsePlaces } from '../src/places.ts';
import { app } from '../src/server.ts';
import { Tempest } from '../src/tempest.ts';
import { Upstream } from '../src/upstream.ts';

const v = <T>(value: T) => ({ en: value, fr: value });

const truro = {
  type: 'Feature',
  id: 'ns-25',
  geometry: { type: 'Point', coordinates: [-63.28, 45.36] },
  properties: {
    identifier: 'ns-25',
    name: v('Truro'),
    region: v('Colchester County - Truro and south'),
    currentConditions: {
      timestamp: v('2026-09-29T22:00:00Z'),
      station: { code: v('zdb'), value: v('Debert') },
      temperature: { value: v(17.2) },
      windChill: { value: v(-1) },
    },
    forecastGroup: {
      timestamp: v('2026-09-29T19:00:00Z'),
      forecasts: [
        {
          period: { textForecastName: v('Tonight') },
          textSummary: v('Rain. Low 14.'),
        },
      ],
    },
    hourlyForecastGroup: { hourlyForecasts: [] },
    warnings: [],
  },
};

const debert = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-63.4659, 45.4215] },
  properties: {
    iata_id: 'CZDB',
    name: 'DEBERT',
    msc_id: '8201390',
    auto_man: 'AUTO',
  },
};

const report = {
  type: 'Feature',
  id: '2026-09-29-2247-CZDB-AUTO-minute-swob.xml',
  geometry: { type: 'Point', coordinates: [-63.4659, 45.4215] },
  properties: {
    'tc_id-value': 'ZDB',
    'stn_nam-value': 'DEBERT',
    'date_tm-value': '2026-09-29T22:47:00.000Z',
    air_temp: 16.5,
    snw_dpth: 5,
    'snw_dpth-qa': -10,
  },
};

const collection = (...features: unknown[]) =>
  Response.json({ type: 'FeatureCollection', features });

async function fakeFetch(input: string): Promise<Response> {
  const url = new URL(input);
  const path = url.pathname;
  if (path.endsWith('/citypageweather-realtime/items/ns-25')) {
    return Response.json(truro);
  }
  if (path.endsWith('/citypageweather-realtime/items')) {
    return url.searchParams.has('q') ? collection() : collection(truro);
  }
  if (path.endsWith('/swob-stations/items')) return collection(debert);
  if (path.endsWith('/swob-realtime/items')) return collection(report);
  if (path.endsWith('/weather-alerts/items')) return collection();
  return new Response('not found', { status: 404 });
}

function server() {
  const upstream = new Upstream(fakeFetch);
  const tempest = new Tempest(upstream, []);
  const places = new Places(
    upstream,
    tempest,
    parsePlaces('debert=45.363,-63.276'),
  );
  return app({ upstream, tempest, places });
}

describe('/v1', () => {
  test('current conditions merge the city page and its station', async () => {
    const res = await server().request('/v1/current-conditions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    expect(body.place).toMatchObject({ name: 'debert', cityPageId: 'ns-25' });
    expect(body.official).toMatchObject({
      station: 'Debert',
      temperatureC: 17.2,
      observedAt: '2026-09-29 19:00 ADT',
    });
    expect(body.official?.windChill).toBeUndefined();
    expect(body.latestStationReading).toMatchObject({
      station: 'DEBERT',
      temperatureC: 16.5,
    });
    expect(body.latestStationReading?.snowDepthCm).toBeUndefined();
    expect(body.errors).toBeUndefined();
  });

  test('a bad number is a 400 and an unknown place a 404', async () => {
    const app = server();
    expect((await app.request('/v1/forecast?hours=99')).status).toBe(400);
    expect((await app.request('/v1/forecast?place=Nowhereville')).status).toBe(
      404,
    );
  });

  test('the index lists every operation', async () => {
    const body = (await (await server().request('/v1')).json()) as {
      operations: { mcpTool: string }[];
    };
    expect(body.operations.map((o: { mcpTool: string }) => o.mcpTool)).toEqual(
      operationNames,
    );
  });
});

interface Rpc {
  result: {
    tools: { name: string; annotations: { readOnlyHint: boolean } }[];
    isError?: boolean;
    content: { text: string }[];
  };
}

describe('/mcp', () => {
  const rpc = (body: unknown) =>
    server().request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify(body),
    });

  test('lists one read-only tool per operation', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { result } = (await res.json()) as Rpc;
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(
      operationNames,
    );
    expect(result.tools[0]?.annotations.readOnlyHint).toBe(true);
  });

  test('a failed call is a tool error the model can read', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forecast', arguments: { place: 'Nowhereville' } },
    });
    const { result } = (await res.json()) as Rpc;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no Canadian place matches');
  });

  test('refuses GET, having no stream to offer', async () => {
    expect((await server().request('/mcp')).status).toBe(405);
  });
});
