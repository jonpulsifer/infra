/**
 * What an installation nobody has configured is shown instead of the product.
 *
 * Rendered to static markup, which is the right depth for what is claimed:
 * every rule below is a statement about **what is on screen in a given step**,
 * and the step is a prop for exactly that reason — a component that owned it
 * could only ever be asserted on its first screen.
 *
 * Four claims, and they are not the same claim:
 *
 * 1. **The four questions are four questions this build can answer.** Onboarding
 *    is the one screen allowed to name manifest keys, and the price of that
 *    permission is a test that walks every named key through the schema. A key
 *    that leaves the schema has to fail here rather than become a step that
 *    renders nothing.
 * 2. **Each step asks its own question and nothing else.** "Everything else is
 *    derived and never asked" is the whole shape of this screen; a step that
 *    also rendered the rest of the document would be the settings form with a
 *    progress bar, which is what this is not.
 * 3. **One write, at the end.** Only the last step offers to configure, because
 *    `writeStoredManifest` reconciles Targets in the same transaction and four
 *    saves would be four reconciliations of four incomplete documents.
 * 4. **A refusal is the same three things it is on the settings screen.** The
 *    two surfaces write through the same command and meet the same refusals, so
 *    they render them through the same component rather than through two
 *    readings that could drift apart — `NOT_DEPLOYABLE` above all, which is the
 *    one a form is most likely to flatten into "fix this field".
 *
 * And one claim that is none of those and is the acceptance criterion itself:
 * **an unconfigured installation is shown onboarding instead of the product.**
 * That is asserted against `SignedIn` — the real branch `App` renders after a
 * session exists — rather than against `OnboardingView`, because a wizard
 * nothing reaches onboards nobody. The discovery panel shipped in exactly that
 * state: every test around it passed, and deleting the one line that mounted it
 * on the settings screen changed nothing.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Principal } from '../../src/commands/types.ts';
import { DEFAULT_PLACEHOLDER_MANIFEST } from '../../src/config/manifest.ts';
import { SignedIn } from '../../src/web/app.tsx';
import type { FieldErrors } from '../../src/web/forms/render.tsx';
import type { SaveOutcome } from '../../src/web/views/auth/installation.tsx';
import {
  manifestFieldAt,
  ONBOARDING_ASKS,
  OnboardingView,
} from '../../src/web/views/auth/onboarding.tsx';

/** The document an unconfigured installation actually holds. */
const UNCONFIGURED = DEFAULT_PLACEHOLDER_MANIFEST as unknown;

function screen({
  step = 0,
  document = UNCONFIGURED,
  errors = new Map() as FieldErrors,
  outcome = null as SaveOutcome | null,
  saving = false,
} = {}): string {
  return renderToStaticMarkup(
    <OnboardingView
      step={step}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
      onChange={() => undefined}
      onStep={() => undefined}
      onFinish={() => undefined}
      onDone={() => undefined}
    />,
  );
}

/** Every control this build could render for the manifest, by its own name. */
const CONTROLS = {
  installation: 'name="installation"',
  clientId: 'name="github.clientId"',
  registry: 'name="supplyChain.registry.0"',
  // Not asked by any step, and the check that step 2 is a step rather than the
  // whole form: it is a key on the same document that onboarding never offers.
  frontend: 'name="build.zeroConfigFrontend"',
} as const;

describe('the four questions are questions this build can answer', () => {
  test('every key onboarding names resolves in the schema', () => {
    // The permission this screen has and `installation.tsx` does not, paid for
    // mechanically. Deployment facts are being taken out of this schema as the
    // chart absorbs them; a step naming one that has gone must fail here.
    for (const ask of ONBOARDING_ASKS) {
      if (ask.kind !== 'field') continue;
      expect(manifestFieldAt(ask.at)).not.toBeNull();
    }
  });

  test('a key the schema does not have resolves to nothing', () => {
    // A detector nobody has seen fail is not a detector. `dns.apexZone` is a
    // key this schema really did carry and really did replace, with
    // `dns.zones`, so it is the honest stale path to prove the walk with.
    expect(manifestFieldAt(['dns', 'apexZone'])).toBeNull();
  });
});

describe('each step asks its own question and nothing else', () => {
  test('the first asks what this installation is called', () => {
    const markup = screen({ step: 0 });
    expect(markup).toContain(CONTROLS.installation);
    expect(markup).not.toContain(CONTROLS.clientId);
    expect(markup).not.toContain(CONTROLS.registry);
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('the second asks which GitHub App this installation speaks as', () => {
    const markup = screen({ step: 1 });
    expect(markup).toContain(CONTROLS.clientId);
    expect(markup).not.toContain(CONTROLS.registry);
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('the third asks the cloud rather than the operator', () => {
    // The settings screen's own discovery panel, mounted here rather than
    // reimplemented: its narrowing inputs are the fingerprint that this is the
    // real one and not a second ask that could answer differently.
    const markup = screen({ step: 2 });
    expect(markup).toContain('name="discovery.project"');
    expect(markup).toContain('name="discovery.kmsLocation"');
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('the fourth asks where artifacts are published', () => {
    const markup = screen({ step: 3 });
    expect(markup).toContain(CONTROLS.registry);
    expect(markup).not.toContain(CONTROLS.installation);
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('what an operator confirms is what this installation already holds', () => {
    // Confirmation, not authorship: the control arrives carrying the value the
    // row has, so an operator who agrees with it presses Continue.
    expect(screen({ step: 0 })).toContain(
      `value="${DEFAULT_PLACEHOLDER_MANIFEST.installation}"`,
    );
  });
});

describe('one write, at the end', () => {
  test('no step before the last offers to configure anything', () => {
    for (let step = 0; step < ONBOARDING_ASKS.length - 1; step += 1) {
      expect(screen({ step })).not.toContain('Configure this installation');
    }
  });

  test('the last step is the one that writes', () => {
    expect(screen({ step: ONBOARDING_ASKS.length - 1 })).toContain(
      'Configure this installation',
    );
  });

  test('a written document ends the wizard with the ceremony step two deferred', () => {
    // Step two says the GitHub authorization needs this value stored first.
    // This is that promise kept: `beginRepositoryAuthorization` reads the
    // client id off the stored manifest, so the offer appears exactly when the
    // document has landed and not before.
    const markup = screen({
      step: 0,
      outcome: { kind: 'saved', targets: ['primary'] },
    });
    expect(markup).toContain('This installation is configured.');
    expect(markup).toContain('Authorize GitHub');
    // And the questions are gone — a saved document is the end of this screen's
    // job whatever step the save was pressed from.
    expect(markup).not.toContain(CONTROLS.installation);
  });
});

describe('a refusal is the same three things it is on the settings screen', () => {
  test('a document this installation cannot take is a fact, not a field', () => {
    const markup = screen({
      step: 3,
      outcome: {
        kind: 'refused',
        message: 'manifest Target primary uses cloudrun, but the stored Target',
      },
    });
    expect(markup).toContain('This installation cannot take that manifest.');
    expect(markup).toContain(
      'This is a fact about the installation, not a field to correct',
    );
  });

  test('an invalid value is shown against the control that produced it', () => {
    const markup = screen({
      step: 0,
      errors: new Map([['installation', ['Too small: expected string']]]),
    });
    expect(markup).toContain('Too small: expected string');
  });
});

describe('an unconfigured installation is shown onboarding, not the product', () => {
  const OPERATOR: Principal = { id: 'usr_test', displayName: 'Operator' };

  function signedIn(
    installation: Parameters<typeof SignedIn>[0]['installation'],
  ) {
    return renderToStaticMarkup(
      <SignedIn
        principal={OPERATOR}
        installation={installation}
        path="/"
        onNavigate={() => undefined}
        onConfigured={() => undefined}
        onSignOut={() => undefined}
      />,
    );
  }

  test('the wizard is what an unconfigured installation renders', () => {
    const markup = signedIn({
      state: 'unconfigured',
      manifest: UNCONFIGURED,
    });
    expect(markup).toContain('Step 1 of 4');
    expect(markup).toContain(CONTROLS.installation);
  });

  test('the product is not rendered underneath it', () => {
    // "Instead of a broken app", not "in front of one". The shell's navigation
    // is the fingerprint: it is what reaches the six screens an unconfigured
    // installation has nothing to put on.
    const unconfigured = signedIn({
      state: 'unconfigured',
      manifest: UNCONFIGURED,
    });
    const configured = signedIn({ state: 'configured' });
    expect(configured).toContain('Overview');
    expect(unconfigured).not.toContain('Overview');
  });

  test('a configured installation never sees it', () => {
    expect(signedIn({ state: 'configured' })).not.toContain('Step 1 of 4');
  });
});
