/**
 * The settings screen ticket 32 slice 1 exists to build.
 *
 * Rendered to static markup, which is the right depth for what is claimed:
 * every rule below is a statement about **what is on the screen in a given
 * state**, and none is about interaction.
 *
 * Three things are being asserted, and they are not the same thing:
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
 * 3. **An adopt act is offered exactly when there is a declaration to adopt**
 *    (ticket 78). The cost is stated before the press: what a `declared` write
 *    does to a Target whose connection moves.
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
  divergence = [] as readonly string[],
  declaration = null as unknown,
} = {}): string {
  return renderToStaticMarkup(
    <InstallationSettingsView
      fields={manifestFields()}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
      divergence={divergence}
      declaration={declaration}
      onChange={() => undefined}
      onSave={() => undefined}
      onReload={() => undefined}
      onAdopted={() => undefined}
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
    // caused it. `targets.0.vessel` names one row of one array — a Target has
    // no name of its own, so `vessel` is the field this now pins.
    expect(markup).toContain('name="dns.zones.0.name"');
    expect(markup).toContain('name="targets.0.vessel"');
  });

  test('the pinned zero-config frontend is one of them', () => {
    // The specific value that cannot be corrected any other way: a declaration
    // seeds only an empty row, and an installation with a row keeps it. This
    // input is the whole of the hand ticket 29's second item was missing.
    expect(markup).toContain('name="build.zeroConfigFrontend"');
    expect(markup).toContain(manifest.build.zeroConfigFrontend);
  });

  test('the page states what saving does, and it is not a card', () => {
    // Every top-level key this schema declares has structure, so the "plain"
    // half of the split is empty for every manifest this build can hold — and
    // a card was drawn around it regardless: a title, a blurb, and a
    // permanently empty body sitting above the twelve cards that are the
    // document. The claim it made was never a section's, it was the page's.
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

/**
 * Nothing on this screen is somebody else's to write.
 *
 * The two vessels this installation is built on used to reconcile from the
 * mounted declaration at every restart, so the form rendered them locked — a
 * field that accepted a value and lost it is worse than one that refuses. There
 * is no declaration to reconcile from any more, and the two invariants that
 * lock protected are refusals the schema already makes: a pointer naming no
 * declared vessel, and a home vessel with no shared services. What replaced the
 * "an installation that cannot come back" argument is the export beside Save —
 * it covers every key rather than four.
 */
describe('the whole document is this screen\u2019s', () => {
  /** The fixture plus a boundary neither pointer names. */
  const withAppVessel = {
    ...manifest,
    vessels: [...manifest.vessels, { name: 'elsewhere', kind: 'cluster' }],
  };

  /** Whether the control with this `name` is rendered disabled. */
  function locked(markup: string, name: string): boolean {
    const control = new RegExp(`<[^>]*name="${name}"[^>]*>`).exec(markup)?.[0];
    if (control === undefined) throw new Error(`no control named ${name}`);
    return control.includes('disabled=""');
  }

  test('every value is editable, declaration mounted or not', () => {
    for (const markup of [
      screen({ document: withAppVessel }),
      screen({ document: withAppVessel, declaration: manifest }),
    ]) {
      expect(locked(markup, 'installation.controlPlaneVessel')).toBe(false);
      expect(locked(markup, 'installation.homeVessel')).toBe(false);
      expect(locked(markup, 'vessels.1.shared.sourceBucket')).toBe(false);
      expect(locked(markup, 'build.zeroConfigFrontend')).toBe(false);
      expect(markup).not.toContain('declared</span>');
    }
  });

  test('the document can be written down as well as edited', () => {
    // The other half of what makes those fields safe to hand over: an
    // installation that can be exported is one that can be restored, which is
    // the whole of what the governed slice was protecting.
    expect(screen({ document: withAppVessel })).toContain(
      'Download this installation',
    );
  });
});

describe('adopting a divergent declaration', () => {
  test('no divergence, no notice and no adopt act', () => {
    const markup = screen();
    expect(markup).not.toContain(
      'The mounted declaration no longer matches this installation.',
    );
    expect(markup).not.toContain('Adopt this declaration');
  });

  test('a divergence with nothing to adopt says so, but offers no press', () => {
    // Reachable when a caller has paths but no document for them — a test
    // context that computed one without the other. The notice still names
    // the disagreement; it just cannot act on it.
    const markup = screen({ divergence: ['build.zeroConfigFrontend'] });
    expect(markup).toContain(
      'The mounted declaration no longer matches this installation.',
    );
    expect(markup).toContain('Differs at: build.zeroConfigFrontend.');
    expect(markup).not.toContain('Adopt this declaration');
  });

  test('a divergence with a declaration offers the adopt act, and its cost', () => {
    const markup = screen({
      divergence: ['build.zeroConfigFrontend'],
      declaration: manifest,
    });
    expect(markup).toContain('Adopt this declaration');
    // The cost, named beside the button rather than after the press: a
    // `declared` write is what resets a moved Target connection to unhealthy
    // pending inspection (`manifest-store.ts`'s `reconcileManifestTargets`).
    expect(markup).toContain('reset to unhealthy');
    expect(markup).toContain('awaiting-inspection checklist');
  });
});
