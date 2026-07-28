/**
 * What a backend calls the thing core placed.
 *
 * One rule, three backends, and the reason it is one rule is the failure mode
 * truncation has: `<app>-<component>` cut to a limit makes two Components of one
 * long-named App **the same name**, and a re-deploy of the same name is an
 * upgrade — so one Component silently starts serving the other's image. Nothing
 * goes red. That is the quiet failure this file exists to make impossible.
 */
import { describe, expect, test } from 'bun:test';
import { workloadName } from '../../src/domain/workload-name.ts';

describe('a name under the limit is the plain one', () => {
  test('what a human reading the backend expects to see', () => {
    expect(workloadName({ app: 'shop', component: 'web' }, 63)).toBe(
      'shop-web',
    );
  });

  test('a name exactly at the limit is not shortened', () => {
    const name = workloadName({ app: 'a'.repeat(20), component: 'b' }, 22);
    expect(name).toBe(`${'a'.repeat(20)}-b`);
    expect(name).toHaveLength(22);
  });
});

describe('over the limit, the tail is a digest and never a cut', () => {
  const app = 'a-very-long-application-name-indeed';

  test('the result fits, at every limit a backend imposes', () => {
    // 30 is the static site id, 63 the Service and the Kubernetes object.
    for (const limit of [30, 63]) {
      expect(
        workloadName({ app, component: 'the-front-end' }, limit).length,
      ).toBeLessThanOrEqual(limit);
    }
  });

  test('two Components of one App stay two names', () => {
    // Truncation alone collides here, and the second deploy would replace the
    // first rather than fail.
    const front = workloadName({ app, component: 'the-front-end' }, 30);
    const back = workloadName({ app, component: 'the-back-end' }, 30);
    expect(front).not.toBe(back);
  });

  test('the same input is the same name, every time', () => {
    // A second deploy that computed a different name would create a second
    // workload rather than replace the first.
    expect(workloadName({ app, component: 'web' }, 30)).toBe(
      workloadName({ app, component: 'web' }, 30),
    );
  });

  test('enough of the plain name survives to be recognisable', () => {
    expect(workloadName({ app, component: 'web' }, 30)).toStartWith('a-very-');
  });

  test('an absurdly small limit still produces a name', () => {
    // No backend has one this small; the guard exists so that a limit nobody
    // anticipated produces a name rather than an empty string.
    expect(workloadName({ app, component: 'web' }, 4).length).toBeGreaterThan(
      0,
    );
  });
});
