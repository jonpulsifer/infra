/**
 * The Kubernetes adapter's chart values. `Chart.yaml` is in `spindrift#test`'s
 * turbo inputs, so a chart-only change reruns the contract check.
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
    // `uri` is CloudNativePG's key for the full connection string in the
    // `<cluster>-app` Secret it generates.
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

  test('a secret reference into another namespace is mirrored, not refused', () => {
    // A `secretKeyRef` cannot cross a namespace, so `remoteSecretName` has the
    // chart render an ExternalSecret against the datastore namespace's store.
    const values = appValues(
      desiredWith([
        {
          name: 'DATABASE_URL',
          connection: 'secret://spindrift-datastores/orders-app',
        },
      ]),
      'registry.example.test/shop/web@sha256:feed',
      'app-shop',
    );

    expect(values.datastores).toEqual([
      {
        name: 'DATABASE_URL',
        remoteSecretName: 'orders-app',
        secretKey: 'uri',
      },
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
