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
    for (const field of manifestFields()) {
      expect(markup).toContain(`name="${field.key}`);
    }
  });

  test('a nested key is reached by its own path', () => {
    // Dotted paths let a Zod issue land on the input that caused it.
    expect(markup).toContain('name="dns.zones.0.name"');
    expect(markup).toContain('name="targets.0.vessel"');
  });

  test('the pinned zero-config frontend is one of them', () => {
    expect(markup).toContain('name="build.zeroConfigFrontend"');
    expect(markup).toContain(manifest.build.zeroConfigFrontend);
  });

  test('the page states what saving does, and it is not a card', () => {
    // Every top-level key has structure, so no card of plain fields exists to
    // carry the save sentence.
    expect(
      manifestFields().every(
        (field) => field.node.kind === 'object' || field.node.kind === 'array',
      ),
    ).toBe(true);
    expect(markup).toContain('<h2');
    expect(markup).toContain('reconciles the Targets it declares');
    expect(markup.split('Installation manifest').length - 1).toBe(1);
  });

  test('a value the schema calls a url is entered as one', () => {
    expect(markup).toContain('type="url"');
  });

  test('a nullable key can be said to be absent', () => {
    // `auth.gateway` is null in the fixture, which is a stated answer, not a blank.
    expect(markup).toContain('name="auth.gateway--present"');
    expect(markup).toContain('Stated as none');
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
      errors: new Map([['dns.zones.0.name', ['must be a lowercase DNS name']]]),
      outcome: {
        kind: 'invalid',
        message: 'This manifest is not valid, so nothing was written.',
      },
    });
    expect(markup).toContain('must be a lowercase DNS name');
    expect(markup).toContain('This manifest was refused.');
  });

  test('NOT_DEPLOYABLE is a fact about the installation, not a field to fix', () => {
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
    // Writing a manifest is the one act that creates a Target nobody named.
    const markup = screen({
      outcome: { kind: 'saved', targets: ['cluster', 'cloud-cloudrun'] },
    });
    expect(markup).toContain('This installation was configured.');
    expect(markup).toContain('cluster, cloud-cloudrun');
  });
});

describe('the whole document is this screen\u2019s', () => {
  // The fixture plus a vessel neither installation pointer names.
  const withAppVessel = {
    ...manifest,
    vessels: [...manifest.vessels, { name: 'elsewhere', kind: 'cluster' }],
  };

  function locked(markup: string, name: string): boolean {
    const control = new RegExp(`<[^>]*name="${name}"[^>]*>`).exec(markup)?.[0];
    if (control === undefined) throw new Error(`no control named ${name}`);
    return control.includes('disabled=""');
  }

  test('every value is editable', () => {
    const markup = screen({ document: withAppVessel });
    expect(locked(markup, 'installation.controlPlaneVessel')).toBe(false);
    expect(locked(markup, 'installation.homeVessel')).toBe(false);
    expect(locked(markup, 'vessels.1.shared.sourceBucket')).toBe(false);
    expect(locked(markup, 'build.zeroConfigFrontend')).toBe(false);
    expect(markup).not.toContain('declared</span>');
  });

  test('the document can be written down as well as edited', () => {
    expect(screen({ document: withAppVessel })).toContain(
      'Download this installation',
    );
  });
});

describe('a list is drawn as what its values are', () => {
  const markup = screen();

  test('a closed set is the whole set, toggled', () => {
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('name="dns.zones.0.reaches--private"');
    expect(markup).toContain('name="dns.zones.0.reaches--public"');
  });

  test('a record carries its own name, not its index', () => {
    // The name is the record's first string field with a value.
    for (const zone of manifest.dns.zones) expect(markup).toContain(zone.name);
    for (const route of manifest.build.routes) {
      expect(markup).toContain(route.name);
      expect(markup).toContain(route.adapter);
    }
  });

  test('a shut entry keeps its fields in the document', () => {
    // Closed content stays mounted and hidden, so find-in-page still reaches it.
    expect(markup).toContain('data-[state=closed]:hidden');
    expect(markup).toContain('name="targets.0--variant"');
  });
});
