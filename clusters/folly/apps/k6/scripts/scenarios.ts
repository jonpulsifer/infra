import { check } from 'k6';
import http from 'k6/http';
import type { Options } from 'k6/options';

// URLs arrive from the TestRun's runner env so the zone names stay in
// cluster-settings; this file never names a host.
const targets = {
  app: __ENV.TARGET_APP_URL,
  control_plane: __ENV.TARGET_CONTROL_PLANE_URL,
  edge: __ENV.TARGET_EDGE_URL,
};

const smoke = (exec: string) => ({
  executor: 'constant-arrival-rate' as const,
  rate: 2,
  timeUnit: '1s',
  duration: '60s',
  preAllocatedVUs: 5,
  exec,
});

export const options: Options = {
  scenarios: {
    app: smoke('app'),
    control_plane: smoke('control_plane'),
    edge: smoke('edge'),
  },
  thresholds: {
    'http_req_failed{scenario:app}': ['rate<0.01'],
    'http_req_failed{scenario:control_plane}': ['rate<0.01'],
    'http_req_failed{scenario:edge}': ['rate<0.01'],
    'http_req_duration{scenario:app}': ['p(95)<500'],
    'http_req_duration{scenario:control_plane}': ['p(95)<1000'],
    'http_req_duration{scenario:edge}': ['p(95)<2000'],
  },
};

const hit = (url?: string) => {
  const res = http.get(url ?? '');
  check(res, { 'status is 200': () => res.status === 200 });
};

export function app() {
  hit(targets.app);
}

export function control_plane() {
  hit(targets.control_plane);
}

export function edge() {
  hit(targets.edge);
}
