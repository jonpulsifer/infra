/**
 * The manifests the read-only profile leans on agree with the code that
 * stamps its sandboxes: a CiliumNetworkPolicy whose selector matches nothing
 * fails open, and RBAC cannot subtract a grant added by mistake.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { HANDS_LABEL } from '../src/lease.ts';
import { NETWORKS } from '../src/profiles.ts';
import { CHECKOUT_LABEL, sandboxLabels } from '../src/sandboxes.ts';
import { GUILD, INVESTIGATOR, OPERATOR, THREAD } from './hands-support.ts';

type Json = Record<string, any>;

const ROOT = new URL('../../../', import.meta.url);
const MATE_DIR = 'clusters/offsite/apps/mate/';
const NAME = 'app.kubernetes.io/name';
const READ_VERBS = ['get', 'list', 'watch'];

/** Every document in a repo file. */
async function documents(path: string): Promise<Json[]> {
  const parsed = Bun.YAML.parse(await Bun.file(new URL(path, ROOT)).text());
  return [parsed].flat().filter(Boolean) as Json[];
}

async function one(path: string, kind: string, name: string): Promise<Json> {
  const found = (await documents(path)).find(
    (doc) => doc.kind === kind && doc.metadata?.name === name,
  );
  if (!found) throw new Error(`no ${kind} ${name} in ${path}`);
  return found;
}

/** Each CiliumNetworkPolicy in mate's directory, with the file it sits in. */
async function policies(): Promise<{ file: string; policy: Json }[]> {
  const files = readdirSync(new URL(MATE_DIR, ROOT)).filter((file) =>
    file.endsWith('.yaml'),
  );
  const found: { file: string; policy: Json }[] = [];
  for (const file of files) {
    for (const doc of await documents(`${MATE_DIR}${file}`)) {
      if (doc.kind === 'CiliumNetworkPolicy') found.push({ file, policy: doc });
    }
  }
  return found;
}

function policyNamed(all: { policy: Json }[], name: string): Json {
  const found = all.find((p) => p.policy.metadata.name === name)?.policy;
  if (!found) throw new Error(`no CiliumNetworkPolicy ${name}`);
  return found;
}

describe('the read-only sandbox network', () => {
  test("every policy file is in the kustomization's resources", async () => {
    const [kustomization] = await documents(`${MATE_DIR}kustomization.yaml`);
    const files = new Set((await policies()).map((p) => p.file));
    expect(files.size).toBeGreaterThan(0);
    for (const file of files) expect(kustomization?.resources).toContain(file);
  });

  test('every network a profile names is selected by a listed policy', async () => {
    const selected = (await policies()).map(
      (p) => p.policy.spec.endpointSelector.matchLabels?.[NAME],
    );
    for (const network of NETWORKS) expect(selected).toContain(network);
  });

  test("the reader policies select what an investigator's sandbox is stamped with", async () => {
    const all = await policies();
    const stamped = sandboxLabels(THREAD, GUILD, INVESTIGATOR);
    expect(
      policyNamed(all, 'mate-sandbox-reader').spec.endpointSelector,
    ).toEqual({ matchLabels: { [NAME]: stamped[NAME] } });
    expect(
      policyNamed(all, 'mate-sandbox-reader-checkout').spec.endpointSelector,
    ).toEqual({
      matchLabels: { [NAME]: stamped[NAME], [CHECKOUT_LABEL]: 'open' },
    });
    expect(stamped[CHECKOUT_LABEL]).toBe('open');
  });

  test('the reader reaches DNS and the two API servers, and nothing else', async () => {
    const reader = policyNamed(await policies(), 'mate-sandbox-reader');
    const [topology] = await documents(
      'clusters/folly/config/cluster-topology.json',
    );
    const host = topology?.data.API_SERVER_HOSTNAME as string;
    const folly = `${host.split('.')[0]}.\${SECRET_DOMAIN}`;
    expect(reader.spec.ingress).toBeUndefined();

    const rules = reader.spec.egress as Json[];
    const ports = (rule: Json) =>
      (rule.toPorts ?? []).flatMap((to: Json) =>
        to.ports.map((p: Json) => `${p.port}/${p.protocol}`),
      );
    for (const rule of rules) {
      expect(rule.toCIDR).toBeUndefined();
      expect(rule.toCIDRSet).toBeUndefined();
      expect(ports(rule)).not.toContain('22/TCP');
      for (const entity of rule.toEntities ?? []) {
        expect(['world', 'all', 'host', 'remote-node']).not.toContain(entity);
      }
    }
    const fqdns = rules.filter((rule) => rule.toFQDNs);
    expect(fqdns.map((rule) => rule.toFQDNs)).toEqual([[{ matchName: folly }]]);
    expect(fqdns.map(ports)).toEqual([['6443/TCP']]);
    expect(
      rules.filter((rule) => rule.toEntities).map((rule) => rule.toEntities),
    ).toEqual([['kube-apiserver']]);

    const dns = rules.filter((rule) => rule.toEndpoints);
    expect(dns.map((rule) => rule.toEndpoints)).toEqual([
      [
        {
          matchLabels: {
            'io.kubernetes.pod.namespace': 'kube-system',
            'k8s-app': 'kube-dns',
          },
        },
      ],
    ]);
    const patterns = dns.flatMap((rule) =>
      rule.toPorts.flatMap((to: Json) => to.rules?.dns ?? []),
    );
    expect(patterns.filter((p: Json) => p.matchPattern)).toEqual([
      { matchPattern: '**.cluster.local' },
    ]);
    expect(rules).toHaveLength(dns.length + fqdns.length + 1);
  });

  test('the checkout window opens github.com on 443 only', async () => {
    const checkout = policyNamed(
      await policies(),
      'mate-sandbox-reader-checkout',
    );
    expect(checkout.spec.egress).toEqual([
      {
        toFQDNs: [{ matchName: 'github.com' }],
        toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }] }],
      },
    ]);
  });

  test('the baseline lives with the live sandbox policy and selects every sandbox mate mints', async () => {
    const all = await policies();
    const baseline = all.find(
      (p) => p.policy.metadata.name === 'mate-sandbox-baseline',
    );
    expect(baseline?.file).toBe('sandbox-network-policy.yaml');
    expect(baseline?.policy.spec.endpointSelector).toEqual({
      matchExpressions: [{ key: HANDS_LABEL, operator: 'Exists' }],
    });
  });
});

describe('the read-only sandbox account', () => {
  const FORBIDDEN = [
    'secrets',
    'nodes/proxy',
    'serviceaccounts/token',
    'pods/exec',
    'pods/attach',
    'pods/portforward',
  ];

  function checkRules(rules: Json[]): void {
    for (const rule of rules) {
      for (const verb of rule.verbs) expect(READ_VERBS).toContain(verb);
      for (const resource of rule.resources as string[]) {
        expect(FORBIDDEN).not.toContain(resource);
        expect(resource).not.toMatch(/\/(exec|attach|portforward)$/);
        if (rule.apiGroups.includes('')) expect(resource).not.toBe('*');
      }
      expect(rule.apiGroups).not.toContain('*');
    }
  }

  test('the ClusterRole reads, and never Secrets or exec', async () => {
    const role = await one(
      'clusters/base/apps/mate-sandbox-reader/rbac.yaml',
      'ClusterRole',
      'mate-sandbox-reader',
    );
    checkRules(role.rules);
  });

  test('the monitoring Role proxies GETs to Prometheus and Alertmanager only', async () => {
    const role = await one(
      'clusters/base/monitoring/mate-sandbox-reader.yaml',
      'Role',
      'mate-sandbox-reader',
    );
    checkRules(role.rules);
    // A new name goes here on purpose, once no GET on it changes state.
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['services/proxy'],
        resourceNames: [
          'prom-stack-kube-prometheus-prometheus:9090',
          'prom-stack-kube-prometheus-alertmanager:9093',
        ],
        verbs: ['get'],
      },
    ]);
  });

  test('mate may mint a token for the account its Deployment names', async () => {
    const deployment = await one(
      `${MATE_DIR}deployment.yaml`,
      'Deployment',
      'mate',
    );
    const env = deployment.spec.template.spec.containers.find(
      (container: Json) => container.name === 'mate',
    ).env as { name: string; value?: string }[];
    const reader = env.find(
      (entry) => entry.name === 'MATE_SANDBOX_KUBE_READER_SA',
    )?.value;
    const admin = env.find(
      (entry) => entry.name === 'MATE_SANDBOX_KUBE_SA',
    )?.value;
    expect(reader).toBeDefined();
    expect(reader).not.toBe(admin);
    const role = await one(`${MATE_DIR}rbac.yaml`, 'Role', 'mate');
    const minting = (role.rules as Json[]).find((rule) =>
      rule.resources.includes('serviceaccounts/token'),
    );
    expect(minting?.resourceNames).toContain(reader);
  });
});

describe("the operator's overrides", () => {
  // The prompt tells the model it may comment `atlantis apply`; Atlantis
  // decides whether that comment applies.
  test('claim an apply only the Atlantis policy grants', async () => {
    expect(OPERATOR.overrides(OPERATOR.grants)).toContain(
      'comment `atlantis apply`',
    );
    const appliers = await Bun.file(
      new URL('clusters/offsite/apps/atlantis/policies/appliers.rego', ROOT),
    ).text();
    const set = /atlantis_appliers := \{([^}]*)\}/.exec(appliers)?.[1] ?? '';
    expect(set).toContain('"clanky-bot[bot]"');
  });
});
