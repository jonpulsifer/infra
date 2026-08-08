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
  declarationGoverns = false,
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
      declarationGoverns={declarationGoverns}
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
    expect(markup).toContain('name="dns.zones.private"');
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

/**
 * Ticket 81's second clause: the two vessels the installation is built on
 * reconcile from the mounted declaration on boot **and render read-only**.
 *
 * The lock is the point rather than the refusal behind it. `loadStoredManifest`
 * re-applies the declaration to those two entries at every restart, so a field
 * an operator can type into here is a field that accepts a value and loses it —
 * which is the failure `views/targets/list.tsx` renders its own sentence for.
 */
describe('the vessels this installation is built on are read-only', () => {
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

  test('a declaration locks the pointers and the entries they name', () => {
    const markup = screen({
      document: withAppVessel,
      declaration: manifest,
      declarationGoverns: true,
    });

    expect(locked(markup, 'installation.controlPlaneVessel')).toBe(true);
    expect(locked(markup, 'installation.homeVessel')).toBe(true);
    // Everything under a governed entry, not only its name: the shared services
    // are the half a boot most often takes back, and the half three commands
    // used to write.
    expect(locked(markup, 'vessels.1.name')).toBe(true);
    expect(locked(markup, 'vessels.1.shared.sourceBucket')).toBe(true);
    // By name, resolved against the document. The third boundary is nobody's
    // but this screen's, and so is every ordinary key.
    expect(locked(markup, 'vessels.2.name')).toBe(false);
    expect(locked(markup, 'build.zeroConfigFrontend')).toBe(false);
  });

  test('the lock carries the sentence saying why', () => {
    // A disabled input with nothing beside it reads as a bug in the form.
    expect(
      screen({
        document: withAppVessel,
        declaration: manifest,
        declarationGoverns: true,
      }),
    ).toContain('are declared, not configured here');
  });

  test('a governed field is marked declared where it is, not only at the top', () => {
    // The sentence above is one sentence at the top of a page that runs to
    // twelve cards, and the fields it explains were rendered as `disabled`,
    // which is the same attribute a save in flight sets. A declared value is
    // the most authoritative thing on the screen and it read as the most
    // broken.
    const markup = screen({
      document: withAppVessel,
      declaration: manifest,
      declarationGoverns: true,
    });

    expect(markup).toContain('declared</span>');
    // At the boundary the answer changes, not on every descendant of it: a
    // governed vessel would otherwise carry eight identical badges inside one
    // card to say one thing.
    expect(markup.split('declared</span>').length - 1).toBeLessThan(
      manifestFields().length,
    );
    expect(screen({ document: withAppVessel })).not.toContain(
      'declared</span>',
    );
  });

  test('with no declaration mounted the whole document is this screen’s', () => {
    // Governance is what a declaration does on a boot. An installation running
    // without one owns its document outright — which is how the shared services
    // are configured at all on an install that mounts nothing.
    const markup = screen({ document: withAppVessel });

    expect(locked(markup, 'installation.homeVessel')).toBe(false);
    expect(locked(markup, 'vessels.1.shared.sourceBucket')).toBe(false);
    expect(markup).not.toContain('are declared, not configured here');
  });

  test('a mounted declaration that governs nothing locks nothing', () => {
    // The chart-only install. The chart mounts its stand-in so the passkey
    // relying party is the hostname the release actually serves, and a stand-in
    // asserts nothing about anybody's boundaries — so this screen has to be the
    // one place those two values can be set, not the one place they cannot.
    //
    // The server answers whether the declaration governs; this screen must not
    // lock on `declaration` being present, which is the shape that shipped the
    // wizard nobody could finish.
    const markup = screen({
      document: withAppVessel,
      declaration: manifest,
      declarationGoverns: false,
    });

    expect(locked(markup, 'installation.homeVessel')).toBe(false);
    expect(locked(markup, 'vessels.1.shared.artifactsProject')).toBe(false);
    expect(markup).not.toContain('are declared, not configured here');
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
