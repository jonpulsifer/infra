/**
 * `helm template` over the kthx chart, parsed.
 *
 * `render-cluster-apps.sh` in CI proves this chart renders. It cannot prove
 * what it renders, and the three facts below are exactly the ones a reader
 * checks by eye and gets wrong: a Service selector that also matches the
 * nightly dump pod renders perfectly and takes half the zone down while the Job
 * lives.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHART = dirname(import.meta.dir);

interface Rendered {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  spec?: any;
}

/** The installation's own values, minus anything a test asserts on. */
const VALUES = {
  image: 'ghcr.io/jonpulsifer/kthx@sha256:feed',
  bucket: 'bluenose-kthx',
  envFromSecret: 'kthx-env',
  adminSecret: 'kthx-admin',
  node: 'oldschool',
  gcp: {
    audience: '//iam.googleapis.com/projects/1/locations/global/x',
    impersonationUrl: 'https://iamcredentials.googleapis.com/v1/x',
  },
};

async function render(
  values: Record<string, unknown> = VALUES,
): Promise<Rendered[]> {
  const file = join(tmpdir(), `kthx-values-${crypto.randomUUID()}.json`);
  await Bun.write(file, JSON.stringify(values));
  try {
    const helm = Bun.spawn(
      [
        'helm',
        'template',
        'kthx',
        CHART,
        '--namespace',
        'kthx',
        '--values',
        file,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(helm.stdout).text(),
      new Response(helm.stderr).text(),
      helm.exited,
    ]);
    if (code !== 0)
      throw new Error(`helm template failed (${code}): ${stderr}`);
    const documents = Bun.YAML.parse(stdout) as unknown;
    return (Array.isArray(documents) ? documents : [documents]).filter(
      (d): d is Rendered =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as any).kind === 'string',
    );
  } finally {
    await Bun.file(file)
      .delete()
      .catch(() => {});
  }
}

function one(objects: Rendered[], kind: string): Rendered {
  const matches = objects.filter((o) => o.kind === kind);
  if (matches.length !== 1)
    throw new Error(`expected exactly one ${kind}, got ${matches.length}`);
  return matches[0] as Rendered;
}

describe('the Service selector', () => {
  test('does not also match the nightly dump pod', async () => {
    const objects = await render();
    const selector: Record<string, string> = one(objects, 'Service').spec
      .selector;
    const dumpPod: Record<string, string> = one(objects, 'CronJob').spec
      .jobTemplate.spec.template.metadata.labels;

    expect(Object.keys(selector).length).toBeGreaterThan(0);
    // A dump pod that satisfies every selector key joins the Service as a
    // second endpoint — Ready as soon as it starts, listening on nothing.
    const matched = Object.entries(selector).every(
      ([key, value]) => dumpPod[key] === value,
    );
    expect(matched).toBe(false);

    // ...and the pod the Service exists for still does match it.
    const serverPod: Record<string, string> = one(objects, 'Deployment').spec
      .template.metadata.labels;
    for (const [key, value] of Object.entries(selector)) {
      expect(serverPod[key]).toBe(value);
    }
  });
});

describe('the GCP credential', () => {
  test('is an external_account document pointing at the projected token', async () => {
    const objects = await render();
    const configMap = objects.find(
      (o) => o.kind === 'ConfigMap' && o.metadata.name === 'kthx-gcp',
    );
    const document = JSON.parse(
      configMap?.data?.['gcp-credentials.json'] ?? '{}',
    );
    expect(document.type).toBe('external_account');
    expect(document.audience).toBe(VALUES.gcp.audience);

    // The document names a path; the pod has to project the token there or
    // every depot call fails at the first token read, with a valid-looking
    // credential on disk.
    const pod = one(objects, 'Deployment').spec.template.spec;
    const projected = pod.volumes.find((v: any) => v.name === 'gcp-federation');
    const mount = pod.containers[0].volumeMounts.find(
      (m: any) => m.name === 'gcp-federation',
    );
    const tokenPath = projected.projected.sources.find(
      (s: any) => s.serviceAccountToken,
    ).serviceAccountToken.path;
    expect(document.credential_source.file).toBe(
      `${mount.mountPath}/${tokenPath}`,
    );
  });
});

describe('the operator key', () => {
  test('is a second, optional envFrom — a missing Secret must not stop the pod', async () => {
    const envFrom = one(await render(), 'Deployment').spec.template.spec
      .containers[0].envFrom;
    expect(envFrom.map((e: any) => e.secretRef.name)).toEqual([
      'kthx-env',
      'kthx-admin',
    ]);
    expect(envFrom[0].secretRef.optional).toBeUndefined();
    expect(envFrom[1].secretRef.optional).toBe(true);
  });

  test('is absent when unset, which is the nuke turned off', async () => {
    const objects = await render({ ...VALUES, adminSecret: '' });
    const envFrom = one(objects, 'Deployment').spec.template.spec.containers[0]
      .envFrom;
    expect(envFrom).toHaveLength(1);
  });
});

describe('the readiness probe', () => {
  test('sends the zone as Host, which is the only name the process answers', async () => {
    const objects = await render({ ...VALUES, zone: 'example.test' });
    const probe = one(objects, 'Deployment').spec.template.spec.containers[0]
      .readinessProbe;
    const host = probe.httpGet.httpHeaders.find(
      (h: any) => h.name === 'Host',
    ).value;
    expect(host).toBe('example.test');
  });
});

describe('the load-bearing values', () => {
  test.each(['bucket', 'image', 'envFromSecret'])(
    'refuses to render without %s',
    async (key) => {
      const values = { ...VALUES, [key]: '' };
      expect(render(values)).rejects.toThrow(key);
    },
  );
});

describe('the private host', () => {
  const CONTROL = { host: 'kthx.lab.test', listener: 'lab-tls' };

  test('is a second route on the named TLS listener, published to DNS', async () => {
    const objects = await render({ ...VALUES, control: CONTROL });
    const routes = objects.filter((o) => o.kind === 'HTTPRoute');
    expect(routes).toHaveLength(2);
    const control = routes.find(
      (r) => r.metadata.name === 'kthx-control',
    ) as Rendered;
    expect(control.spec.hostnames).toEqual([CONTROL.host]);
    expect(control.spec.parentRefs[0].sectionName).toBe(CONTROL.listener);
    // No hold-out: this name's record is meant to be the gateway's address.
    expect((control.metadata as any).annotations).toBeUndefined();
    // ...and the public route keeps its own, or external-dns claims the zone.
    const zone = routes.find((r) => r.metadata.name === 'kthx') as Rendered;
    expect(Object.keys((zone.metadata as any).annotations)).not.toHaveLength(0);

    const env = one(objects, 'Deployment').spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === 'KTHX_CONTROL_HOST').value).toBe(
      CONTROL.host,
    );
  });

  test('is absent when unset, and refuses a host with no listener', async () => {
    const objects = await render();
    expect(objects.filter((o) => o.kind === 'HTTPRoute')).toHaveLength(1);
    const env = one(objects, 'Deployment').spec.template.spec.containers[0].env;
    expect(
      env.find((e: any) => e.name === 'KTHX_CONTROL_HOST'),
    ).toBeUndefined();
    expect(
      render({ ...VALUES, control: { host: CONTROL.host, listener: '' } }),
    ).rejects.toThrow('control.listener');
  });
});
