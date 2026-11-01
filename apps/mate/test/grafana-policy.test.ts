import { expect, test } from 'bun:test';

const directory = new URL(
  '../../../clusters/base/monitoring/grafana-mate/',
  import.meta.url,
);

async function yaml(file: string): Promise<any> {
  return Bun.YAML.parse(await Bun.file(new URL(file, directory)).text());
}

test('Grafana trusts only the local sidecar and issues no login token', async () => {
  const release = await yaml('helm-release.yaml');
  const grafana = release.spec.values.grafana;
  expect(grafana['grafana.ini']['auth.proxy']).toEqual({
    enabled: true,
    header_name: 'X-WEBAUTH-USER',
    header_property: 'username',
    auto_sign_up: true,
    whitelist: '127.0.0.1',
    headers: 'Role:X-WEBAUTH-ROLE',
    sync_ttl: 0,
    enable_login_token: false,
  });
  const sidecar = grafana.extraContainers[0];
  expect(sidecar.ports).toEqual([{ name: 'mate-query', containerPort: 8081 }]);
  expect(sidecar.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(sidecar.securityContext.readOnlyRootFilesystem).toBe(true);
});

test('the query gateway discards caller headers and permits three operations', async () => {
  const config = await Bun.file(new URL('nginx.conf', directory)).text();
  const map = config.match(
    /map "\$request_method:\$request_uri" \$mate_query \{([^}]+)\}/,
  )?.[1];
  expect(
    map
      ?.trim()
      .split('\n')
      .map((line) => line.trim()),
  ).toEqual([
    'default 0;',
    '~^GET:/api/user$ 1;',
    '~^GET:/api/datasources$ 1;',
    '~^POST:/api/ds/query$ 1;',
  ]);
  expect(config).toContain('if ($mate_query = 0) { return 403; }');
  expect(config).toContain('proxy_pass http://127.0.0.1:3000;');
  expect(config).toContain('proxy_pass_request_headers off;');
  expect(config).toContain(
    'proxy_set_header X-WEBAUTH-USER mate-investigator;',
  );
  expect(config).toContain('proxy_set_header X-WEBAUTH-ROLE Viewer;');
  expect(config).toContain('proxy_hide_header Set-Cookie;');
});

test('only the Kubernetes API and trusted node reach the sidecar', async () => {
  const policy = await yaml('network-policy.yaml');
  const service = await yaml('service.yaml');
  expect(policy.spec.endpointSelector.matchLabels).toEqual(
    service.spec.selector,
  );
  expect(service.spec.ports).toEqual([
    { name: 'http', port: 8081, targetPort: 'mate-query' },
  ]);
  expect(policy.spec.ingress).toEqual([
    {
      fromEntities: ['all'],
      toPorts: [{ ports: [{ port: '3000', protocol: 'TCP' }] }],
    },
    {
      fromEntities: ['host', 'kube-apiserver'],
      toPorts: [{ ports: [{ port: '8081', protocol: 'TCP' }] }],
    },
  ]);
});
