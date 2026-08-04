/**
 * Ticket 77: a chart-only install seeds a manifest whose relying party is the
 * hostname it actually serves.
 *
 * `packages/charts/spindrift/files/default-manifest.yaml` is a second, chart-side
 * copy of `DEFAULT_PLACEHOLDER_MANIFEST` — templated with the release's own
 * `controlPlane.hostname` in place of the code's `spindrift.example.com`, so a
 * release with no `manifest:` value and a `hostname` seeds a document whose
 * passkey relying party is the origin the release is actually served at rather
 * than a name no browser on that origin can complete a ceremony against
 * (`src/web/serve.ts:210-213` binds the relying party to whichever hostname the
 * seeded document carries).
 *
 * A second copy of the placeholder is exactly the shape 33 spent a ticket
 * refusing to let drift — every other manifest fact the chart could restate is
 * instead derived or refused at render time. This one is kept anyway because
 * `hostname` is the one deployment fact the *code's* placeholder cannot know at
 * import time (it is a release value, not a constant), so unlike
 * `cloud.federation` or `controlPlane.hostname` in an operator's own
 * declaration, there is no credential or Values field this chart renders that
 * the manifest could instead read back. What is not accepted is the drift: this
 * suite diffs the chart's file against the code's constant on every run, so a
 * value changed in one without the other is a red test rather than a wizard
 * nobody can reach.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  isUnconfiguredInstallation,
  validateManifest,
} from '../../src/config/manifest.ts';

/** The repository root, for reading the chart's copy of the placeholder. */
const REPO_ROOT = join(import.meta.dir, '../../../..');
const DEFAULT_MANIFEST_FILE = join(
  REPO_ROOT,
  'packages/charts/spindrift/files/default-manifest.yaml',
);

/**
 * The chart's file is a Helm template, not standalone YAML — its one
 * substitution is `{{ .Values.hostname | quote }}` at `controlPlane.hostname`.
 * Standing in for what `tpl` would render with the code's own placeholder
 * hostname turns "the chart's copy" and "the code's copy" into the same
 * document, so a plain deep-equal is the whole check: no Helm binary, no
 * `helm template` invocation, just the text this repository already carries.
 */
async function renderedDefaultManifest(): Promise<unknown> {
  const raw = await Bun.file(DEFAULT_MANIFEST_FILE).text();
  const rendered = raw.replace(
    '{{ .Values.hostname | quote }}',
    JSON.stringify(DEFAULT_PLACEHOLDER_MANIFEST.controlPlane.hostname),
  );
  expect(rendered).not.toContain('{{');
  return Bun.YAML.parse(rendered);
}

describe('the chart-only default manifest matches the code copy', () => {
  test('is byte-for-byte the placeholder once the hostname substitution is applied', async () => {
    expect(await renderedDefaultManifest()).toEqual(
      DEFAULT_PLACEHOLDER_MANIFEST,
    );
  });

  test('is valid against the schema the process boots with', async () => {
    // Proves box 1 structurally: nothing in `installationManifestSchema` is
    // optional, so a chart-side copy that drifted a key out of existence would
    // refuse here rather than crash-looping a fresh installation instead.
    const rendered = await renderedDefaultManifest();
    expect(() =>
      validateManifest(rendered, 'chart default manifest'),
    ).not.toThrow();
  });

  test('still answers isUnconfiguredInstallation, so a chart-only install lands on onboarding', async () => {
    // Box 2. The four genuine choices — installation, github.clientId,
    // secretStore.adapter, supplyChain.registry — are untouched by the
    // hostname substitution, so the seeded document reads exactly as
    // unconfigured as `DEFAULT_PLACEHOLDER_MANIFEST` itself does.
    const seeded = validateManifest(
      await renderedDefaultManifest(),
      'chart default manifest',
    );
    expect(isUnconfiguredInstallation(seeded)).toBe(true);
  });

  test('a hostname the code placeholder does not carry still reads as unconfigured', async () => {
    // The substitution above proves equality only at the code's own stand-in
    // hostname. A real release's hostname is never that string, so this is the
    // case that actually ships: the relying party changes, the four genuine
    // choices do not, and the predicate must still answer true.
    const raw = await Bun.file(DEFAULT_MANIFEST_FILE).text();
    const rendered = raw.replace(
      '{{ .Values.hostname | quote }}',
      JSON.stringify('spindrift.lolwtf.ca'),
    );
    const seeded = validateManifest(
      Bun.YAML.parse(rendered),
      'chart default manifest',
    );
    expect(seeded.controlPlane.hostname).toBe('spindrift.lolwtf.ca');
    expect(isUnconfiguredInstallation(seeded)).toBe(true);
  });
});
