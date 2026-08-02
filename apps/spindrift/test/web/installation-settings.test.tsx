/**
 * The settings screen ticket 32 slice 1 exists to build.
 *
 * Rendered to static markup, which is the right depth for what is claimed:
 * every rule below is a statement about **what is on the screen in a given
 * state**, and none is about interaction.
 *
 * Two things are being asserted, and they are not the same thing:
 *
 * 1. **A control exists for every manifest value**, derived from the schema, so
 *    a key an operator has to correct is reachable. This is the half seven
 *    tickets are waiting on — the live installation pins a zero-config frontend
 *    that resolves nowhere, a declaration only seeds an empty row, and until
 *    this screen there was no hand to change it with.
 * 2. **The three refusals read as three different things.**
 *    `configureInstallation` distinguishes "your document is wrong" from "this
 *    installation cannot take it", and flattening the second into a form error
 *    would tell an operator to fix a field that is not wrong.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { manifestFields } from '../../src/web/forms/manifest.ts';
import type { FieldErrors } from '../../src/web/forms/render.tsx';
import type { SaveOutcome } from '../../src/web/views/auth/installation.tsx';
import { InstallationSettingsView } from '../../src/web/views/auth/installation.tsx';
import { fixtureManifest } from '../harness/installation.ts';

const manifest = await fixtureManifest();

function screen({
  document = manifest as unknown,
  errors = new Map() as FieldErrors,
  outcome = null as SaveOutcome | null,
  saving = false,
} = {}): string {
  return renderToStaticMarkup(
    <InstallationSettingsView
      fields={manifestFields()}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
      onChange={() => undefined}
      onSave={() => undefined}
      onReload={() => undefined}
    />,
  );
}

describe('every manifest value is reachable', () => {
  const markup = screen();

  test('a control exists for each key the schema declares', () => {
    // By the schema's keys rather than a list here, for the same reason the
    // screen renders by them: a list in a test rots exactly as fast as a list
    // in a component.
    for (const field of manifestFields()) {
      expect(markup).toContain(`name="${field.key}`);
    }
  });

  test('a nested key is reached by its own path', () => {
    // Dotted paths are what let a Zod issue be rendered against the input that
    // caused it. `targets.0.name` names one row of one array.
    expect(markup).toContain('name="dns.zones.private"');
    expect(markup).toContain('name="targets.0.name"');
  });

  test('the pinned zero-config frontend is one of them', () => {
    // The specific value that cannot be corrected any other way: a declaration
    // seeds only an empty row, and an installation with a row keeps it. This
    // input is the whole of the hand ticket 29's second item was missing.
    expect(markup).toContain('name="build.zeroConfigFrontend"');
    expect(markup).toContain(manifest.build.zeroConfigFrontend);
  });

  test('a value the schema calls a url is entered as one', () => {
    expect(markup).toContain('type="url"');
  });

  test('a nullable key can be said to be absent', () => {
    // `auth.gateway` is null in the fixture — passkeys are the only path — and
    // the screen has to be able to render that as a chosen configuration
    // rather than as an empty box.
    expect(markup).toContain('name="auth.gateway--present"');
    expect(markup).toContain('not configured');
  });

  test('a discriminated union offers its arms', () => {
    expect(markup).toContain('name="targets.0--variant"');
    for (const target of manifest.targets) {
      expect(markup).toContain(`value="${target.adapter}"`);
    }
  });

  test('saving disables the form rather than letting a second save start', () => {
    expect(screen({ saving: true })).toContain('disabled=""');
  });
});

describe('a refusal reads as what it is', () => {
  test('an invalid document is reported against the field that is wrong', () => {
    const markup = screen({
      errors: new Map([
        ['dns.zones.private', ['must be a lowercase DNS name']],
      ]),
      outcome: {
        kind: 'invalid',
        message: 'This manifest is not valid, so nothing was written.',
      },
    });
    expect(markup).toContain('must be a lowercase DNS name');
    expect(markup).toContain('This manifest was refused.');
  });

  test('NOT_DEPLOYABLE is a fact about the installation, not a field to fix', () => {
    // §3's disabled-with-reasons grammar: the caller is told something about
    // the world. A Target that already exists with a different adapter is not
    // something re-typing a value in this form resolves, and a form error
    // saying "fix this" would be false.
    const markup = screen({
      outcome: {
        kind: 'refused',
        message:
          'manifest Target cluster uses cloudrun, but the stored Target uses kubernetes',
      },
    });
    expect(markup).toContain('This installation cannot take that manifest.');
    expect(markup).toContain('not a field to correct');
    expect(markup).not.toContain('This manifest was refused.');
  });

  test('a transport refusal is about the request, not the manifest', () => {
    const markup = screen({
      outcome: {
        kind: 'failed',
        message: 'this surface is reachable only with a session',
      },
    });
    expect(markup).toContain('That save did not happen.');
    expect(markup).not.toContain('This manifest was refused.');
    expect(markup).not.toContain(
      'This installation cannot take that manifest.',
    );
  });

  test('a success names the Targets the write reconciled', () => {
    // Writing a manifest is the one act that creates a Target without anybody
    // naming one, so a confirmation that did not say so would hide it.
    const markup = screen({
      outcome: { kind: 'saved', targets: ['cluster', 'cloud-cloudrun'] },
    });
    expect(markup).toContain('This installation was configured.');
    expect(markup).toContain('cluster, cloud-cloudrun');
  });
});
