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
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { VALUES_CONTRACT } from '../../src/adapters/deploy/kubernetes/values.ts';

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
