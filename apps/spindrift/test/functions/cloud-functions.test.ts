/**
 * The Cloud Run functions deployer.
 *
 * Every test drives the real class against a fake of the runtime's HTTP API
 * (§ Seam 2). The claims worth stating:
 *
 * - **Read before write**, because the API has separate verbs for the first
 *   deploy and every one after it.
 * - **The source object is named by its digest**, so redeploying unchanged
 *   sources overwrites one object rather than growing the bucket.
 * - **The deploy is not finished when the API accepts it** — the operation is
 *   followed, and an operation that finishes with an error is a failure.
 * - **Openness is the Service's own field**, never an `allUsers` binding.
 */
import { describe, expect, test } from 'bun:test';
import { CloudRunFunctions } from '../../src/functions/cloud-functions.ts';
import { FunctionDeployError } from '../../src/functions/contract.ts';

const ENDPOINTS = {
  functions: 'https://functions.example.test',
  run: 'https://run.example.test',
  storage: 'https://storage.example.test',
  logs: 'https://logs.example.test',
};

const SOURCE = 'export default { fetch: () => new Response("hi") };';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly request: Request;
}

/** A fake far side: routes keyed on `METHOD <pathname>`, plus a call log. */
function api(routes: Readonly<Record<string, () => Response>>): {
  fetch: (request: Request) => Promise<Response>;
  calls: Seen[];
  keys(): string[];
} {
  const calls: Seen[] = [];
  return {
    calls,
    keys: () =>
      calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    fetch: async (request) => {
      calls.push({ method: request.method, url: request.url, request });
      const key = `${request.method} ${new URL(request.url).pathname}`;
      const route = routes[key];
      return route === undefined ? Response.json({}) : route();
    },
  };
}

function deployer(fetch: (request: Request) => Promise<Response>) {
  return new CloudRunFunctions({
    token: () => 'cloud-token',
    project: 'example-vessel',
    region: 'somewhere',
    sourceBucket: 'example-sources',
    runtimeServiceAccount: 'runner@example-vessel.test',
    functionsEndpoint: ENDPOINTS.functions,
    runEndpoint: ENDPOINTS.run,
    storageEndpoint: ENDPOINTS.storage,
    logsEndpoint: ENDPOINTS.logs,
    fetch,
    sleep: async () => {},
  });
}

const PARENT = 'projects/example-vessel/locations/somewhere';

function missing(): Response {
  return Response.json(
    { error: { message: 'not found', status: 'NOT_FOUND' } },
    { status: 404 },
  );
}

describe('CloudRunFunctions.deploy', () => {
  test('stages the archive and creates a function that is not there', async () => {
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: missing,
      [`POST /v2/${PARENT}/functions`]: () =>
        Response.json({ name: `${PARENT}/operations/op-1`, done: false }),
      [`GET /v2/${PARENT}/operations/op-1`]: () =>
        Response.json({
          name: `${PARENT}/operations/op-1`,
          done: true,
          response: { url: 'https://fn-hello-x.run.example.test' },
        }),
    });

    const result = await deployer(far.fetch).deploy('hello', SOURCE, {});
    expect(result.url).toBe('https://fn-hello-x.run.example.test');
    expect(far.keys()).toEqual(
      [
        '/upload/storage/v1/b/example-sources/o',
        `GET /v2/${PARENT}/functions/fn-hello`,
        `POST /v2/${PARENT}/functions`,
        `GET /v2/${PARENT}/operations/op-1`,
        `PATCH /v2/${PARENT}/services/fn-hello`,
      ].map((key, index) => (index === 0 ? `POST ${key}` : key)),
    );

    const upload = new URL(far.calls[0]!.url);
    expect(upload.searchParams.get('uploadType')).toBe('media');
    expect(upload.searchParams.get('name')).toMatch(
      /^functions\/fn-hello\/[0-9a-f]{64}\.zip$/,
    );
    expect(far.calls[0]!.request.headers.get('Content-Type')).toBe(
      'application/zip',
    );

    const created = (await far.calls[2]!.request.json()) as {
      buildConfig: {
        runtime: string;
        entryPoint: string;
        source: { storageSource: unknown };
      };
      serviceConfig: {
        ingressSettings: string;
        serviceAccountEmail: string;
        environmentVariables: Record<string, string>;
      };
      labels: Record<string, string>;
    };
    expect(new URL(far.calls[2]!.url).searchParams.get('functionId')).toBe(
      'fn-hello',
    );
    expect(created.buildConfig.runtime).toBe('nodejs22');
    expect(created.buildConfig.entryPoint).toBe('fn');
    expect(created.buildConfig.source.storageSource).toEqual({
      bucket: 'example-sources',
      object: upload.searchParams.get('name'),
    });
    expect(created.serviceConfig.ingressSettings).toBe('ALLOW_ALL');
    expect(created.serviceConfig.serviceAccountEmail).toBe(
      'runner@example-vessel.test',
    );
    expect(created.labels).toEqual({ 'spindrift-function': 'hello' });
    // Always present: an absent field under this update mask would leave a
    // removed variable on the Service.
    expect(created.serviceConfig.environmentVariables).toEqual({});

    // §9's open cell: the Service's own field, never an `allUsers` binding.
    const opened = far.calls[4]!;
    expect(new URL(opened.url).searchParams.get('updateMask')).toBe(
      'invokerIamDisabled',
    );
    expect(await opened.request.json()).toEqual({ invokerIamDisabled: true });
  });

  test('patches a function that already exists', async () => {
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: () =>
        Response.json({ name: 'fn-hello' }),
      [`PATCH /v2/${PARENT}/functions/fn-hello`]: () =>
        Response.json({
          name: `${PARENT}/operations/op-2`,
          done: true,
          response: { serviceConfig: { uri: 'https://fn-hello.run.test' } },
        }),
    });
    const result = await deployer(far.fetch).deploy('hello', SOURCE, {});
    expect(result.url).toBe('https://fn-hello.run.test');
    const patch = far.calls.find((call) => call.method === 'PATCH')!;
    expect(new URL(patch.url).searchParams.get('updateMask')).toBe(
      'buildConfig,serviceConfig,labels',
    );
  });

  test('sends the environment as the Service’s own variables', async () => {
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: () =>
        Response.json({ name: 'fn-hello' }),
      [`PATCH /v2/${PARENT}/functions/fn-hello`]: () =>
        Response.json({
          name: `${PARENT}/operations/op-6`,
          done: true,
          response: { url: 'https://fn-hello.run.test' },
        }),
    });
    await deployer(far.fetch).deploy('hello', SOURCE, { GREETING: 'hi' });

    const patch = far.calls.find((call) => call.method === 'PATCH')!;
    const body = (await patch.request.json()) as {
      serviceConfig: { environmentVariables: Record<string, string> };
    };
    expect(body.serviceConfig.environmentVariables).toEqual({ GREETING: 'hi' });
  });

  test('follows the operation until it is finished', async () => {
    let polls = 0;
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: missing,
      [`POST /v2/${PARENT}/functions`]: () =>
        Response.json({ name: `${PARENT}/operations/op-3` }),
      [`GET /v2/${PARENT}/operations/op-3`]: () => {
        polls += 1;
        return polls < 3
          ? Response.json({ name: `${PARENT}/operations/op-3`, done: false })
          : Response.json({
              name: `${PARENT}/operations/op-3`,
              done: true,
              response: { url: 'https://fn-hello.run.test' },
            });
      },
    });
    await deployer(far.fetch).deploy('hello', SOURCE, {});
    expect(polls).toBe(3);
  });

  test('a build that failed is the operator’s sentence', async () => {
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: missing,
      [`POST /v2/${PARENT}/functions`]: () =>
        Response.json({
          name: `${PARENT}/operations/op-4`,
          done: true,
          error: { message: 'Build failed: missing semicolon' },
        }),
    });
    const failure = await deployer(far.fetch)
      .deploy('hello', SOURCE, {})
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(FunctionDeployError);
    expect((failure as Error).message).toBe('Build failed: missing semicolon');
  });

  test('names the policy when the Service cannot be opened', async () => {
    const far = api({
      [`GET /v2/${PARENT}/functions/fn-hello`]: missing,
      [`POST /v2/${PARENT}/functions`]: () =>
        Response.json({
          name: `${PARENT}/operations/op-5`,
          done: true,
          response: { url: 'https://fn-hello.run.test' },
        }),
      [`PATCH /v2/${PARENT}/services/fn-hello`]: () =>
        Response.json(
          { error: { message: 'constraint enforced' } },
          { status: 403 },
        ),
    });
    const failure = await deployer(far.fetch)
      .deploy('hello', SOURCE, {})
      .catch((cause: unknown) => cause);
    expect((failure as Error).message).toContain('invokerIamDisabled');
    expect((failure as Error).message).toContain('constraint enforced');
  });
});

describe('CloudRunFunctions.remove', () => {
  test('a function that is already gone is not an error', async () => {
    const far = api({ [`DELETE /v2/${PARENT}/functions/fn-hello`]: missing });
    await expect(deployer(far.fetch).remove('hello')).resolves.toBeUndefined();
    expect(far.keys()).toEqual([`DELETE /v2/${PARENT}/functions/fn-hello`]);
  });
});

describe('CloudRunFunctions.tail', () => {
  test('reads the service’s entries and does not repeat one', async () => {
    let page = 0;
    const far = api({
      'POST /v2/entries:list': () => {
        page += 1;
        return page === 1
          ? Response.json({
              entries: [
                {
                  timestamp: '2026-08-22T00:00:00.000Z',
                  insertId: 'a',
                  textPayload: 'started',
                  severity: 'INFO',
                },
                {
                  timestamp: '2026-08-22T00:00:01.000Z',
                  insertId: 'b',
                  textPayload: 'exploded',
                  severity: 'ERROR',
                },
              ],
            })
          : Response.json({
              entries: [
                {
                  timestamp: '2026-08-22T00:00:01.000Z',
                  insertId: 'b',
                  textPayload: 'exploded',
                  severity: 'ERROR',
                },
                {
                  timestamp: '2026-08-22T00:00:02.000Z',
                  insertId: 'c',
                  textPayload: 'quiet',
                },
              ],
            });
      },
    });

    const abort = new AbortController();
    const seen = [];
    for await (const entry of deployer(far.fetch).tail('hello', abort.signal)) {
      seen.push(entry);
      if (seen.length === 3) abort.abort();
    }
    expect(seen.map((entry) => entry.line)).toEqual([
      'started',
      'exploded',
      'quiet',
    ]);
    expect(seen.map((entry) => entry.level)).toEqual(['info', 'error', 'log']);

    const filter = ((await far.calls[0]!.request.json()) as { filter: string })
      .filter;
    expect(filter).toContain('resource.type="cloud_run_revision"');
    expect(filter).toContain('resource.labels.service_name="fn-hello"');
    expect(filter).toContain('resource.labels.location="somewhere"');
  });
});
