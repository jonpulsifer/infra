// Onboarding is the one screen that names manifest keys, so each named key is
// walked through the schema. Only the last step writes: each write reconciles Targets.
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

const CONTROLS = {
  installation: 'name="installation.name"',
  registry: 'name="supplyChain.registry.0"',
  // No step asks this key, so its absence shows a step is not the whole form.
  frontend: 'name="build.zeroConfigFrontend"',
} as const;

describe('the three questions are questions this build can answer', () => {
  test('every key onboarding names resolves in the schema', () => {
    // A step that names a key the schema dropped must fail here.
    for (const ask of ONBOARDING_ASKS) {
      if (ask.kind !== 'field') continue;
      expect(manifestFieldAt(ask.at)).not.toBeNull();
    }
  });

  test('a key the schema does not have resolves to nothing', () => {
    // Proves the walk can fail on a stale key.
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
    // The settings screen's discovery panel, identified by its narrowing inputs.
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
    // The App identity lives in the `github_app` row, not the manifest.
    expect(stepAsking('github.webBaseUrl')).toBe(-1);
  });

  test('what an operator confirms is what this installation already holds', () => {
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
    // The GitHub manifest flow builds its redirect URLs from the stored manifest.
    const markup = screen({
      step: 0,
      outcome: { kind: 'saved', targets: ['primary'] },
    });
    expect(markup).toContain('This installation is configured.');
    expect(markup).toContain('Connect GitHub');
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
    // `finish` navigates to the step whose control an issue belongs to.
    expect(stepAsking('installation.name')).toBe(0);
    // Matched by prefix, so an array element maps to its array's step.
    expect(stepAsking('supplyChain.registry.0')).toBe(2);
    // Discovery writes keys no step offers a control for.
    expect(stepAsking('secretStore.endpoint')).toBe(-1);
  });
});

describe('the three questions are all visible while one is being answered', () => {
  test('the rail names every step from the first step', () => {
    const markup = screen({ step: 0 });
    for (const ask of ONBOARDING_ASKS) expect(markup).toContain(ask.title);
    expect(markup).toContain('aria-label="Setup steps"');
  });

  test('the progress sentence is still there, and there is no fourth screen', () => {
    // The mounted-app test looks for `Step 1 of 3`.
    expect(screen({ step: 0 })).toContain('Step 1 of 3');
    expect(ONBOARDING_ASKS).toHaveLength(3);
  });
});

describe('an answer is refused where it is given', () => {
  const nameless = {
    ...DEFAULT_PLACEHOLDER_MANIFEST,
    installation: { ...DEFAULT_PLACEHOLDER_MANIFEST.installation, name: '' },
  } as unknown;

  function control(markup: string, label: string): string {
    const end = markup.indexOf(`>${label}</button>`);
    if (end < 0) throw new Error(`no button labelled ${label}`);
    return markup.slice(markup.lastIndexOf('<button', end), end + 1);
  }

  test('only the issues the step in front of you can fix', () => {
    expect([...stepIssues(nameless, 0).keys()]).toEqual(['installation.name']);
    expect(stepIssues(nameless, 1).size).toBe(0);
    expect(stepIssues(DEFAULT_PLACEHOLDER_MANIFEST as unknown, 0).size).toBe(0);
  });

  test('the step that asks refuses to advance, and says why', () => {
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
    // The discovery panel is its own form, so this step has none, and a submit
    // button outside a form does nothing.
    const markup = screen({ step: 1 });
    expect(control(markup, 'Continue')).toContain('type="button"');
    expect(control(screen({ step: 0 }), 'Continue')).toContain('type="submit"');
  });

  test('Enter is a way to answer a question', () => {
    expect(screen({ step: 0 })).toContain('<form');
    expect(screen({ step: 2 })).toContain('<form');
  });

  test('the backstop names the questions, not the schema paths', () => {
    const said = refusalSentence(['installation.name', 'supplyChain.registry']);
    expect(said).toContain('Name this installation');
    expect(said).toContain('Where artifacts are published');
    expect(said).not.toContain('supplyChain.registry');

    // A key no step asks about is named as itself.
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
    // The shell's navigation marks the product.
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
    // `pathLength` lets one keyframe draw any lucide path.
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
    // `startViewTransition` moves the box that holds this name, and a second
    // holder aborts the transition, so exactly one row may hold it.
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
    // The name follows the current step.
    expect(rail(1)).not.toBe(rail(2));
    expect(named(rail(2))).toBe(1);
  });

  test('the cloud panel is a closed track before it has an answer', () => {
    // A transition needs an element at both ends, so the empty track renders.
    const panel = renderToStaticMarkup(
      <DiscoveryPanel document={UNCONFIGURED} onChange={() => undefined} />,
    );
    expect(panel).toContain('grid-rows-[0fr]');
    expect(panel).not.toContain('grid-rows-[1fr]');
  });
});
