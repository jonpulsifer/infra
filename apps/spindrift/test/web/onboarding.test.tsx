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
 * 1. **The three questions are three questions this build can answer.** Onboarding
 *    is the one screen allowed to name manifest keys, and the price of that
 *    permission is a test that walks every named key through the schema. A key
 *    that leaves the schema has to fail here rather than become a step that
 *    renders nothing.
 * 2. **Each step asks its own question and nothing else.** "Everything else is
 *    derived and never asked" is the whole shape of this screen; a step that
 *    also rendered the rest of the document would be the settings form with a
 *    progress bar, which is what this is not.
 * 3. **One write, at the end.** Only the last step offers to configure, because
 *    `writeStoredManifest` reconciles Targets in the same transaction and three
 *    saves would be three reconciliations of three incomplete documents.
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
import { manifestFieldAt } from '../../src/web/forms/manifest.ts';
import type { FieldErrors } from '../../src/web/forms/render.tsx';
import { DiscoveryPanel } from '../../src/web/views/auth/discovery.tsx';
import type { SaveOutcome } from '../../src/web/views/auth/installation.tsx';
import {
  ONBOARDING_ASKS,
  OnboardingView,
  refusalSentence,
  stepAsking,
  stepIssues,
} from '../../src/web/views/auth/onboarding.tsx';
import { StepRail } from '../../src/web/views/auth/step-rail.tsx';

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
      onRestored={() => undefined}
      onStep={() => undefined}
      onFinish={() => undefined}
      onDone={() => undefined}
    />,
  );
}

/** Every control this build could render for the manifest, by its own name. */
const CONTROLS = {
  installation: 'name="installation.name"',
  registry: 'name="supplyChain.registry.0"',
  // Not asked by any step, and the check that step 2 is a step rather than the
  // whole form: it is a key on the same document that onboarding never offers.
  frontend: 'name="build.zeroConfigFrontend"',
} as const;

describe('the three questions are questions this build can answer', () => {
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
    expect(markup).not.toContain(CONTROLS.registry);
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('the second asks the cloud rather than the operator', () => {
    // The settings screen's own discovery panel, mounted here rather than
    // reimplemented: its narrowing inputs are the fingerprint that this is the
    // real one and not a second ask that could answer differently.
    const markup = screen({ step: 1 });
    expect(markup).toContain('name="discovery.project"');
    expect(markup).toContain('name="discovery.kmsLocation"');
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('the third asks where artifacts are published', () => {
    const markup = screen({ step: 2 });
    expect(markup).toContain(CONTROLS.registry);
    expect(markup).not.toContain(CONTROLS.installation);
    expect(markup).not.toContain(CONTROLS.frontend);
  });

  test('GitHub is not a question: the App identity is created, not authored', () => {
    // The manifest carries no App identity key at all — the identity lives in
    // the `github_app` row, written by the manifest flow on the Repositories
    // screen — so no step may ask for one.
    expect(stepAsking('github.webBaseUrl')).toBe(-1);
  });

  test('what an operator confirms is what this installation already holds', () => {
    // Confirmation, not authorship: the control arrives carrying the value the
    // row has, so an operator who agrees with it presses Continue.
    expect(screen({ step: 0 })).toContain(
      `value="${DEFAULT_PLACEHOLDER_MANIFEST.installation.name}"`,
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

  test('a written document ends the wizard with the GitHub ceremony deferred', () => {
    // The manifest flow that creates the App renders its redirect URLs off the
    // stored manifest, so the offer appears exactly when the document has
    // landed and not before.
    const markup = screen({
      step: 0,
      outcome: { kind: 'saved', targets: ['primary'] },
    });
    expect(markup).toContain('This installation is configured.');
    expect(markup).toContain('Connect GitHub');
    // And the questions are gone — a saved document is the end of this screen's
    // job whatever step the save was pressed from.
    expect(markup).not.toContain(CONTROLS.installation);
  });
});

describe('a refusal is the same three things it is on the settings screen', () => {
  test('a document this installation cannot take is a fact, not a field', () => {
    const markup = screen({
      step: 2,
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
      errors: new Map([['installation.name', ['Too small: expected string']]]),
    });
    expect(markup).toContain('Too small: expected string');
  });

  test('a refused value is traced to the step that can fix it', () => {
    // The settings form mounts every field at once and can render an issue
    // wherever it belongs. This one shows a single control, so an issue against
    // `installation` raised on the last step is an issue rendered against a
    // control three steps back — the operator is told the manifest was refused
    // and shown nothing that says what to do. `finish` navigates on this.
    expect(stepAsking('installation.name')).toBe(0);
    // By prefix: an issue names the value that is wrong, a step names the key it
    // asks for, and an array control's elements are neither of the other's.
    expect(stepAsking('supplyChain.registry.0')).toBe(2);
    // And a value no step asks about is not forced onto one. Discovery writes
    // cloud facts this screen never offers a control for.
    expect(stepAsking('secretStore.endpoint')).toBe(-1);
  });
});

describe('the three questions are all visible while one is being answered', () => {
  test('the rail names every step from the first step', () => {
    // The titles have existed since the day `ONBOARDING_ASKS` did and an
    // operator met each one only on arrival — so the step that reads the cloud,
    // and can therefore refuse, was always a surprise three screens in.
    const markup = screen({ step: 0 });
    for (const ask of ONBOARDING_ASKS) expect(markup).toContain(ask.title);
    expect(markup).toContain('aria-label="Setup steps"');
  });

  test('the progress sentence is still there, and there is no fourth screen', () => {
    // `Step 1 of 3` is what the shell asserts against. The rail is beside it,
    // not instead of it, and it adds no question: three asks, one write, and
    // the write is still on the last of them.
    expect(screen({ step: 0 })).toContain('Step 1 of 3');
    expect(ONBOARDING_ASKS).toHaveLength(3);
  });
});

describe('an answer is refused where it is given', () => {
  const nameless = {
    ...DEFAULT_PLACEHOLDER_MANIFEST,
    installation: { ...DEFAULT_PLACEHOLDER_MANIFEST.installation, name: '' },
  } as unknown;

  /** The `<button>` whose whole content is this label. */
  function control(markup: string, label: string): string {
    const end = markup.indexOf(`>${label}</button>`);
    if (end < 0) throw new Error(`no button labelled ${label}`);
    return markup.slice(markup.lastIndexOf('<button', end), end + 1);
  }

  test('only the issues the step in front of you can fix', () => {
    // The map is the whole of the gate, and it is worth pinning without a
    // browser: an issue is actionable on the step that mounts the control it
    // belongs to and nowhere else.
    expect([...stepIssues(nameless, 0).keys()]).toEqual(['installation.name']);
    expect(stepIssues(nameless, 1).size).toBe(0);
    expect(stepIssues(DEFAULT_PLACEHOLDER_MANIFEST as unknown, 0).size).toBe(0);
  });

  test('the step that asks refuses to advance, and says why', () => {
    // Before this, an empty name walked through all three questions and the
    // commit press threw the operator back here reading a sentence of dotted
    // schema paths.
    const markup = screen({ step: 0, document: nameless });
    expect(control(markup, 'Continue')).toContain('disabled=""');
    expect(markup).toContain('Too small: expected string');
  });

  test('a valid answer advances', () => {
    expect(control(screen({ step: 0 }), 'Continue')).not.toContain(
      'disabled=""',
    );
  });

  test('the step with no form of its own still advances when pressed', () => {
    // The discovery step is the one the wizard does not wrap in a form, because
    // the panel it mounts already is one. A `type="submit"` there is a button
    // outside any form, which is a button that does nothing.
    const markup = screen({ step: 1 });
    expect(control(markup, 'Continue')).toContain('type="button"');
    expect(control(screen({ step: 0 }), 'Continue')).toContain('type="submit"');
  });

  test('Enter is a way to answer a question', () => {
    // The wizard had no `<form>` anywhere, so typing an answer and pressing
    // Enter did nothing at all. The discovery step is the exception and has its
    // own reason: its panel already submits, and a form inside a form is not a
    // thing a browser keeps.
    expect(screen({ step: 0 })).toContain('<form');
    expect(screen({ step: 2 })).toContain('<form');
  });

  test('the backstop names the questions, not the schema paths', () => {
    // The end-of-flow check stays — the command is the authority and reports
    // every offending key at once — but this is the one screen whose premise is
    // that keys are named in human terms, and it was reporting them in Zod's.
    const said = refusalSentence(['installation.name', 'supplyChain.registry']);
    expect(said).toContain('Name this installation');
    expect(said).toContain('Where artifacts are published');
    expect(said).not.toContain('supplyChain.registry');

    // A value no step asks about has no question to be named as. Discovery
    // applies cloud facts this screen never offers a control for, so the key
    // itself is the most honest thing left to say.
    expect(refusalSentence(['secretStore.endpoint'])).toContain(
      'secretStore.endpoint',
    );
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
    expect(markup).toContain('Step 1 of 3');
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
    expect(signedIn({ state: 'configured' })).not.toContain('Step 1 of 3');
  });
});

describe('the way back in when there are no answers to give', () => {
  test('the first question offers a restore where Back would be', () => {
    // Nothing to go back to on step one, and the one act a torn-down
    // installation is here to perform: the file it exported, read back.
    const first = screen({ step: 0 });
    expect(first).toContain('Restore from a file');
    expect(first).not.toContain('>Back<');
  });

  test('every later question offers Back instead', () => {
    const second = screen({ step: 1 });
    expect(second).toContain('>Back<');
    expect(second).not.toContain('Restore from a file');
  });
});

describe('what the wizard says by moving', () => {
  test('the finished step draws its tick rather than fading one in', () => {
    // The one status that marks a transition rather than a state, and the one
    // worth animating. `pathLength` is what makes one keyframe draw whatever
    // shape lucide handed over.
    const rail = renderToStaticMarkup(
      <StepRail
        steps={[
          { title: 'Answered', status: 'done', value: 'yes' },
          { title: 'Here', status: 'running' },
          { title: 'Later', status: 'waiting' },
        ]}
        current={1}
      />,
    );
    expect(rail).toContain('pathLength="1"');
    expect(rail).toContain('animate-draw');
  });

  test('the reconciled Targets land in rank order, one behind the next', () => {
    // Rank is the order the write actually worked them in, inside one
    // transaction — so the stagger is the shape of what happened rather than
    // an effect over a finished list.
    const done = screen({
      outcome: {
        kind: 'saved',
        targets: ['cluster/kubernetes', 'cloud/cloudrun'],
      },
    });
    expect(done).toContain('cluster/kubernetes');
    expect(done).toContain('cloud/cloudrun');
    expect(done).toContain('calc(var(--i) * 60ms)');
  });

  test('an installation with no Targets says so, with nothing to stagger', () => {
    const done = screen({ outcome: { kind: 'saved', targets: [] } });
    expect(done).toContain('declares no Targets yet');
    expect(done).not.toContain('calc(var(--i)');
  });

  test('one row at a time carries the name the highlight travels under', () => {
    // What makes `startViewTransition` worth calling: the browser treats the
    // old row and the new one as the same box and moves it. Exactly one row
    // may hold the name — a second aborts the transition — so the count is the
    // claim, not the presence.
    const rail = (current: number) =>
      renderToStaticMarkup(
        <StepRail
          steps={[
            { title: 'First', status: 'done', value: 'yes' },
            { title: 'Second', status: 'running' },
            { title: 'Third', status: 'waiting' },
          ]}
          current={current}
        />,
      );
    const named = (markup: string) =>
      markup.split('view-transition-name').length - 1;

    expect(named(rail(1))).toBe(1);
    // And it is the row the operator is on, which is what makes it travel:
    // the same rail at a different step names a different row.
    expect(rail(1)).not.toBe(rail(2));
    expect(named(rail(2))).toBe(1);
  });

  test('the cloud panel is a closed track before it has an answer', () => {
    // Five rows arriving at once moved the form up the page in one frame. The
    // track is rendered whether or not there is anything in it, because a
    // transition needs an element that existed at both ends.
    const panel = renderToStaticMarkup(
      <DiscoveryPanel document={UNCONFIGURED} onChange={() => undefined} />,
    );
    expect(panel).toContain('grid-rows-[0fr]');
    expect(panel).not.toContain('grid-rows-[1fr]');
  });
});
