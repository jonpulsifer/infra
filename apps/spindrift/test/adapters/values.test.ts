/**
 * The two halves of §7's value contract, checked against each other.
 *
 * §7: "The chart declares its own value contract and version, read at pin
 * time." That is a claim about two files in two packages — `VALUES_CONTRACT`,
 * which is what the code writing the values believes, and the annotation in
 * `packages/charts/spindrift-app/Chart.yaml`, which is what the chart stamps
 * onto every object it renders. Nothing in either package fails when they
 * disagree, and they did: the change that moved the constant to `3` migrated
 * the chart's templates and `values.yaml` in the same commit and left the
 * annotation on `2`, so every rendered object was labelled with a contract
 * Spindrift had stopped writing.
 *
 * The check lives here rather than in the chart's own suite because the
 * dependency runs Spindrift → chart (§20 names the chart as Spindrift's
 * `charts.app`), never the reverse, and because the chart's harness is
 * deliberately sealed off from this package — it "knows about Helm and YAML
 * and nothing else" (`packages/charts/spindrift-app/tests/render.ts`), while
 * `values.ts` reaches into the domain layer.
 *
 * Reading across a package boundary means the runner has to be told: Turbo
 * hashes a task from its own package's files, so `Chart.yaml` is named in
 * `spindrift#test`'s `inputs` in the root `turbo.json`. Without that, the one
 * change this guard exists to catch does not invalidate the task and CI serves
 * a cached pass over a real skew — the same failure as the check it replaced.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  appValues,
  VALUES_CONTRACT,
} from '../../src/adapters/deploy/kubernetes/values.ts';
import type {
  DatastoreAttachment,
  DesiredState,
} from '../../src/domain/desired-state.ts';
import { DEFAULT_PLATFORM } from '../../src/domain/placement.ts';

const CHART_YAML = join(
  import.meta.dir,
  '../../../../packages/charts/spindrift-app/Chart.yaml',
);

describe('the value contract has two halves and they must agree', () => {
  test('the App chart declares the contract this adapter renders', async () => {
    const chart = Bun.YAML.parse(await Bun.file(CHART_YAML).text()) as {
      annotations?: Record<string, string>;
    };

    expect(chart.annotations?.['spindrift.dev/values-contract']).toBe(
      VALUES_CONTRACT,
    );
  });
});

describe('a connection reference becomes an env entry (§11)', () => {
  function desiredWith(
    datastores: readonly DatastoreAttachment[],
  ): DesiredState {
    return {
      deploy: 'deploy-1',
      app: 'shop',
      component: 'web',
      target: 'metal/kubernetes',
      kind: 'service',
      artifact: { type: 'image', digest: 'sha256:feed', refs: [] },
      reach: 'private',
      auth: 'proxy',
      config: [],
      datastores,
      requirements: { platform: DEFAULT_PLATFORM, resources: {} },
      hostname: { canonical: 'shop-web.apps.example.test' },
    };
  }

  test('a secret reference names the operator-owned Secret and its own key', () => {
    // `uri` is CloudNativePG's key for the whole connection string in the
    // `<cluster>-app` Secret it generates — a Kubernetes fact, parsed here
    // rather than in `domain/`, which stores the reference opaque.
    const values = appValues(
      desiredWith([
        {
          name: 'DATABASE_URL',
          connection: 'secret://spindrift-apps/orders-app',
        },
      ]),
      'registry.example.test/shop/web@sha256:feed',
      'spindrift-apps',
    );

    expect(values.datastores).toEqual([
      { name: 'DATABASE_URL', secretName: 'orders-app', secretKey: 'uri' },
    ]);
  });

  test('an address carries no credential, so it is a plain value', () => {
    const values = appValues(
      desiredWith([
        {
          name: 'REDIS_URL',
          connection: 'redis://cache.spindrift-apps.svc.cluster.local:6379',
        },
      ]),
      'registry.example.test/shop/web@sha256:feed',
      'app-shop',
    );

    expect(values.datastores).toEqual([
      {
        name: 'REDIS_URL',
        value: 'redis://cache.spindrift-apps.svc.cluster.local:6379',
      },
    ]);
  });

  test('a document pinned before §11 renders no datastores at all', () => {
    const { datastores: _pinned, ...before } = desiredWith([]);

    expect(
      appValues(
        before,
        'registry.example.test/shop/web@sha256:feed',
        'app-shop',
      ).datastores,
    ).toEqual([]);
  });
});
