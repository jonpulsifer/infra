/**
 * The view assertions Tasks 37, 39, and 40 name, and the rules around them.
 *
 * These are rendered to static markup rather than driven in a browser. That is
 * the right depth for what is being claimed: every rule under test is a
 * statement about **what appears on the screen in a given state**, and none of
 * them is about interaction. A test that needed a click would be testing Radix.
 *
 * The screens are rendered from `test/fixtures/scenarios.ts`, which is the
 * placeholder data. When the query commands replace it these tests keep their
 * subject — they assert over `DeployView` and `WorkspaceView`, and those types
 * are the contract the queries will have to meet.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { logos } from '../../src/web/client/logos/index.ts';
import type { DeployView, WorkspaceView } from '../../src/web/model.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import {
  DeleteConfigVarButton,
  ReachEditor,
  Workspace,
} from '../../src/web/views/apps/workspace.tsx';
import { Gate } from '../../src/web/views/auth/gate.tsx';
import { CredentialSettingsView } from '../../src/web/views/auth/settings.tsx';
import { RepositoryList } from '../../src/web/views/repos/list.tsx';
import { TargetList } from '../../src/web/views/targets/list.tsx';
import {
  BUILD_ATTEMPT,
  DEPLOY_SCENARIOS,
  TARGET_LIST,
  VESSEL_LIST,
  WORKSPACE_SCENARIOS,
} from '../fixtures/scenarios.ts';

const deploy = (view: DeployView) =>
  renderToStaticMarkup(<DeployDetail view={view} />);

const workspace = (view: WorkspaceView) =>
  renderToStaticMarkup(<Workspace view={view} />);

/**
 * The rendered words, with the tags taken out.
 *
 * A stage header is assembled from several spans — an ordinal, a glyph, a name,
 * a verdict — so a claim about the sentence it reads as cannot be made against
 * raw markup without pinning the element boundaries, which is testing the
 * layout rather than the sentence. Collapsing to text asserts what a person
 * sees and survives the next time the header is restyled.
 */
const words = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const RED = Object.entries(DEPLOY_SCENARIOS).filter(
  ([, view]) => view.phase === 'FAILED',
);

describe('the claimed front door', () => {
  test('offers recovery with a rotated enrolment token', () => {
    // §"First run and identity" story 4 makes token rotation the whole recovery
    // procedure. The server already accepts that ceremony; the claimed screen
    // must expose it, or an operator who lost their passkey has no way to start
    // the procedure the product promises.
    const markup = renderToStaticMarkup(
      <Gate claimed={true} onSignedIn={() => undefined} />,
    );

    expect(markup).toContain('Recover with a rotated token');
    expect(markup).toContain('name="recovery-token"');
  });

  test('explains how to link a first Gateway assertion', () => {
    const markup = renderToStaticMarkup(
      <Gate
        claimed={true}
        gatewayUnlinked={true}
        onSignedIn={() => undefined}
      />,
    );
    expect(markup).toContain('Gateway identity is not linked yet');
    expect(markup).toContain('then link it in Settings');
  });
});

describe('authentication Settings', () => {
  test('states the fresh-passkey rule and preserves the final account root', () => {
    const markup = renderToStaticMarkup(
      <CredentialSettingsView
        settings={{
          passkeys: [
            {
              credentialId: 'credential-one',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastUsedAt: null,
            },
          ],
          gatewayAvailable: true,
          gatewayLinked: false,
        }}
        error={null}
        running={null}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onLink={() => undefined}
        onUnlink={() => undefined}
      />,
    );

    expect(markup).toContain('Every change requires a fresh assertion');
    expect(markup).toContain('At least one always remains');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Link this Gateway identity');
  });
});

describe('the GitHub repository connector', () => {
  const actions = {
    onAuthorize: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
  };

  test('uses a provider row and no second page heading inside Settings', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[]}
        connector={{ state: 'unauthorized' }}
        authorization={null}
        connecting={false}
        error={null}
        openedPullRequest={null}
        embedded
        {...actions}
      />,
    );
    expect(markup).toContain('<h3 class="font-semibold">GitHub</h3>');
    expect(markup).toContain('Repository discovery, source events');
    expect(markup).not.toContain('<h1');
  });

  test('starts with user authorization and names no private key', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[]}
        connector={{ state: 'unauthorized' }}
        authorization={null}
        connecting={false}
        error={null}
        openedPullRequest={null}
        {...actions}
      />,
    );
    expect(markup).toContain('Authorize GitHub');
    expect(markup).toContain('never asks for an installation ID');
    expect(markup).not.toContain('App private key');
  });

  test('shows the device code while GitHub authorization is pending', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[]}
        connector={{ state: 'unauthorized' }}
        authorization={{
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.example.test/login/device',
          state: 'waiting',
        }}
        connecting={false}
        error={null}
        openedPullRequest={null}
        {...actions}
      />,
    );
    expect(markup).toContain('ABCD-EFGH');
    expect(markup).toContain('Continue in GitHub');
    expect(markup).not.toContain('device-code-secret');
  });

  /**
   * The whole point of the rebuild, asserted as an absence.
   *
   * Connecting a repository asks for nothing. Every field this screen used to
   * collect — the scope, the kind, the build frontend, the Dockerfile, the
   * build command, the output directory, the watch paths — is something §5's
   * detector reads out of the repository, and a regression here would be the
   * form growing back one field at a time.
   */
  test('offers a repository to connect and asks for nothing', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[
          {
            repositoryId: '99',
            fullName: 'example/app',
            defaultBranch: 'main',
            cloneUrl: 'https://vcs.example/example/app.git',
            rowExists: false,
          },
        ]}
        connector={{
          state: 'authorized',
          login: 'operator',
          githubUserId: '42',
        }}
        authorization={null}
        connecting={false}
        error={null}
        openedPullRequest={null}
        {...actions}
      />,
    );
    expect(markup).toContain('Authorized as @operator');
    expect(markup).toContain('example/app');
    expect(markup).toContain('>Connect<');
    for (const field of [
      'Component kind',
      'Build frontend',
      'Watch paths',
      'Output directory',
      'Build command',
      '<select',
      '<textarea',
    ]) {
      expect(markup).not.toContain(field);
    }
  });
});

describe('the deploy screen names the builder', () => {
  test('states the platform in words and draws its mark', () => {
    // "Building on hosted" names a route, which is a word an installation chose
    // for itself. An operator reading it cannot tell GitHub Actions from Cloud
    // Build, and the two fail in different places over different credentials —
    // so the platform is named beside the route, the way a Target and a
    // repository already identify theirs.
    const view = DEPLOY_SCENARIOS.live;
    expect(view.build?.runnerAdapter).toBe('github-actions');

    const markup = deploy(view);
    // In words, because `Logo` is `aria-hidden` by construction: a mark that is
    // the only carrier of a fact is a fact a screen reader never reads out.
    expect(words(markup)).toContain('GitHub Actions');
    expect(markup).toContain(view.build!.runner);
    // And the mark itself, from the same barrel every other platform mark comes
    // from rather than a second one invented for this panel.
    expect(markup).toContain(logos.github);
  });

  test('a release that was never built names no builder at all', () => {
    // §4's supplied artifact: nothing ran, so there is no platform, and a mark
    // here would be a claim about a builder that was never involved.
    const view = DEPLOY_SCENARIOS.extracted;
    expect(view.build).toBeNull();

    const markup = deploy(view);
    expect(words(markup)).toContain('none · extracted');
    expect(markup).not.toContain(logos.github);
  });
});

describe('the deploy screen, on red', () => {
  test('there is a red state to test', () => {
    expect(RED.length).toBeGreaterThan(0);
  });

  for (const [name, view] of RED) {
    test(`${name} says the previous release is still serving`, () => {
      // §18's line, and the one that "changed the feel of failure more than
      // anything else". §6 guarantees it is true: exposure is never mutated by
      // a failed deploy, so on red a previous release is still up.
      expect(view.previousReleaseServing).toBe(true);
      expect(deploy(view)).toContain('previous release is still serving');
    });

    test(`${name} names its failure reason and blame`, () => {
      const markup = deploy(view);
      expect(view.diagnosis).not.toBeNull();
      expect(markup).toContain(view.diagnosis!.reason);
      if (view.diagnosis!.blame !== null) {
        expect(markup).toContain(view.diagnosis!.blame);
      }
    });

    test(`${name} opens the build log only if the build is what failed`, () => {
      // §18's "auto-opens on red" is about the **build**, not about the screen.
      // A deploy that failed on a green build wants the diagnosis read, not the
      // build log — and opening the log there would contradict the `platform`
      // blame chip three lines above it, which exists precisely to say "the
      // build is fine, stop looking at it".
      //
      // Radix leaves closed content unmounted, so the step list appearing at
      // all is what distinguishes the two.
      //
      // Every red scenario built something — §4's supplied-artifact arm has no
      // build to open, and no failure mode that would want one opened.
      expect(view.build).not.toBeNull();
      const build = view.build!;
      const opened = deploy(view).includes(build.steps[0]!.name);
      expect(opened).toBe(
        build.status === 'failed' || build.status === 'running',
      );
    });
  }

  test('a green build stays collapsed even when the deploy failed', () => {
    // The case that makes the rule above worth having: the build succeeded and
    // the cluster could not pull what it produced.
    const view = DEPLOY_SCENARIOS.imageUnpullable;
    expect(view.build?.status).toBe('done');

    const markup = deploy(view);
    expect(markup).toContain('ARTIFACT_UNAVAILABLE');
    expect(markup).toContain('platform');
    expect(markup).not.toContain('compiled successfully');
    expect(words(markup)).toContain('Deploy · failed');
    expect(markup).toContain('controller accepted the deploy');
  });

  test('names the two stages separately and marks only the one that failed', () => {
    // The whole point of the pair. An artifact that exists is deployable to any
    // supported Target, so a red placement says nothing about the image — and
    // the screen has to be able to hold both facts at once rather than
    // collapsing them into one verdict about "the pipeline".
    const view = DEPLOY_SCENARIOS.imageUnpullable;
    const text = words(deploy(view));

    expect(text).toContain('1 Build · done');
    expect(text).toContain('2 Deploy · failed');
  });

  test('shows the deploy stage even when the Build row is red', () => {
    // Supply-chain admission produces exactly this pairing: the runner pushed
    // an image, the artifact was refused, and the Deploy over it went red on
    // its own. Gating the deploy stage on a green build hid the log on the one
    // screen that needed it and left a build log claiming the whole failure.
    const view: DeployView = {
      ...DEPLOY_SCENARIOS.imageUnpullable,
      build: { ...DEPLOY_SCENARIOS.buildFailed.build, status: 'failed' },
    };
    const text = words(deploy(view));

    expect(text).toContain('2 Deploy · failed');
    expect(deploy(view)).toContain('controller accepted the deploy');
  });

  test('but not when nothing is serving', () => {
    // The sentence is a fact about the platform, not decoration on a red
    // screen. A first deploy that fails has no previous release, and claiming
    // one would be a lie in the reassuring direction — the worst kind.
    const firstDeploy: DeployView = {
      ...DEPLOY_SCENARIOS.buildFailed,
      previousReleaseServing: false,
    };
    expect(deploy(firstDeploy)).not.toContain(
      'previous release is still serving',
    );
  });
});

describe('a red deploy that recorded nothing', () => {
  // The shape every failed Deploy on a real installation has: `debug` null, no
  // `log` event, so `getDeployDetail` projects a diagnosis with no evidence and
  // a null deploy log. The screen has an honest sentence for exactly this and
  // never used to reach it, because `"{}"` arrived where the null belonged.
  const silent: DeployView = {
    ...DEPLOY_SCENARIOS.imageUnpullable,
    diagnosis: {
      ...DEPLOY_SCENARIOS.imageUnpullable.diagnosis!,
      evidence: null,
    },
    deployLog: null,
  };
  const markup = deploy(silent);

  test('still names the failure it does know', () => {
    expect(markup).toContain('ARTIFACT_UNAVAILABLE');
    expect(markup).toContain('platform');
  });

  test('offers no disclosure over evidence it does not have', () => {
    // The trigger promises an answer. Opening it onto an empty pane is the
    // promise broken, and there is nothing to put behind it.
    expect(markup).not.toContain('what Spindrift found');
  });

  test('says the deploy log is live status rather than inventing a line', () => {
    expect(markup).toContain('no text line has arrived yet');
    expect(markup).not.toContain('{}');
  });
});

describe('the build stage, on the transcript it carries', () => {
  // The drawer is the checkpoints. The runner's text is evidence behind one
  // more click, and only ever the tail of it — a drawer that opened onto a
  // thousand lines of BuildKit chatter buried the seven that said what
  // happened.
  test('leads with checkpoints rather than the runner output', () => {
    const text = words(deploy(DEPLOY_SCENARIOS.buildFailed));

    for (const step of DEPLOY_SCENARIOS.buildFailed.build.steps) {
      expect(text).toContain(step.name);
    }
  });

  test('opens the runner output on red, where the last lines are the answer', () => {
    expect(deploy(DEPLOY_SCENARIOS.buildFailed)).toContain(
      'Failed to compile.',
    );
  });

  test('says how much of the log it is showing, and how much it is not', () => {
    // A tail presented as the log is the UI editing evidence. `imageUnpullable`
    // is the green build, whose drawer is shut — so the claim is made on the
    // red one, where the reader is actually looking.
    const clipped: DeployView = {
      ...DEPLOY_SCENARIOS.buildFailed,
      build: { ...DEPLOY_SCENARIOS.buildFailed.build, logTotal: 812 },
    };
    const text = words(deploy(clipped));

    expect(text).toContain('last 8 of 812 lines');
    expect(text).toContain('the full transcript stays on the runner');
  });

  test('claims no tail when it is showing the whole thing', () => {
    const text = words(deploy(DEPLOY_SCENARIOS.buildFailed));

    expect(text).toContain('8 lines');
    expect(text).not.toContain('the full transcript stays on the runner');
  });
});

describe('the deploy screen, on green', () => {
  const markup = deploy(DEPLOY_SCENARIOS.live);

  test('leads with the URL that is serving', () => {
    expect(markup).toContain(DEPLOY_SCENARIOS.live.url);
    expect(markup).toContain('Serving');
  });

  test('collapses the build log', () => {
    // §18: collapsed on green — a finished green build is the one case nobody
    // reads the log for.
    expect(markup).not.toContain('compiled successfully');
  });

  test('carries no diagnosis', () => {
    expect(markup).not.toContain('What Spindrift found');
  });
});

describe('a runner that withholds log text', () => {
  const markup = deploy(DEPLOY_SCENARIOS.building);

  test('labels the checklist as the live view', () => {
    // §18 makes this line load-bearing: without it the screen reads as a
    // broken stream rather than a known limit of that runner.
    expect(DEPLOY_SCENARIOS.building.build.fidelity).toBe('LIVE_STATUS');
    expect(markup).toContain('LIVE_STATUS');
    expect(markup).toContain('the live view');
  });

  test('shows the checklist it just called live', () => {
    expect(markup).toContain('export image');
  });

  test('sends the reader where the text is actually being written', () => {
    // Stating the limit is necessary but not sufficient. The log exists and is
    // live; it is only somewhere Spindrift cannot read from until the run ends,
    // so the sentence that admits that carries the way to go read it.
    const url = DEPLOY_SCENARIOS.building.build.runUrl;
    expect(url).not.toBeNull();
    expect(markup).toContain(`href="${url}"`);
    expect(markup).toContain('Open the run');
  });

  test('opens it away from the app, and without handing over the referrer', () => {
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  test('offers no link where the runner reported none', () => {
    // A guessed URL that 404s is worse than no link, because it is offered at
    // the moment the reader has already been told the log is elsewhere.
    const withoutLink = deploy({
      ...DEPLOY_SCENARIOS.building,
      build: { ...DEPLOY_SCENARIOS.building.build, runUrl: null },
    } as DeployView);
    expect(withoutLink).toContain('the live view');
    expect(withoutLink).not.toContain('Open the run');
  });
});

describe('a release that was extracted rather than built', () => {
  // §4: "An archive of *finished output* is a supplied artifact, digested over
  // the uploaded bundle" — recorded with no build adapter looked up.
  // `uploadArchive` writes that row with a null runner precisely because
  // "saying so is more useful than naming a runner that never ran", and the
  // screen has to carry that sentence rather than invent a builder.
  const view = DEPLOY_SCENARIOS.extracted;
  const markup = deploy(view);

  test('has no build at all', () => {
    expect(view.build).toBeNull();
  });

  test('says no builder was involved instead of showing an empty log', () => {
    expect(markup).toContain('NO BUILD');
    expect(markup).toContain('No builder was involved');
    expect(words(markup)).not.toContain('1 Build ·');
  });

  test('leads with the source, which every release has', () => {
    expect(view.source.kind).toBe('archive');
    expect(markup).toContain('Uploaded archive');
    expect(markup).toContain('recorded as-is, never built');
    if (view.source.kind === 'archive') {
      expect(markup).toContain(view.source.digest);
    }
  });

  test('still names the artifact it delivers', () => {
    // The digest is over the uploaded bundle on both arms (§16), which is what
    // keeps the supply-chain join intact whether or not a build happened.
    expect(markup).toContain('Artifact');
    expect(markup).toContain(view.artifactDigest!);
  });
});

describe('an attempt that is only a Build', () => {
  // §4: pressing Deploy with nothing deployable "writes a PENDING Build for the
  // build loop to dispatch, and that is the whole act". The press still has to
  // land somewhere, and this is the screen it lands on.
  const markup = renderToStaticMarkup(
    <DeployDetail
      view={BUILD_ATTEMPT}
      actions={{ onDeployBuild: () => undefined }}
    />,
  );

  test('has no release id, because no intent was written', () => {
    expect(BUILD_ATTEMPT.id).toBeNull();
  });

  test('names itself a build rather than a deploy', () => {
    expect(markup).toContain(`build ${BUILD_ATTEMPT.buildId}`);
  });

  test('offers to place what the Build produced', () => {
    expect(markup).toContain('Deploy this build');
  });

  test('shows no deploy log, because nothing was applied', () => {
    // §6 gives the deploy leg its own drawer. There is no deploy leg here, and
    // rendering an empty one would say the platform was asked and said nothing.
    expect(words(markup)).not.toContain('2 Deploy ·');
  });
});

describe('the compact App history', () => {
  const view = WORKSPACE_SCENARIOS.service;
  const markup = renderToStaticMarkup(
    <Workspace view={view} onNavigate={() => undefined} />,
  );

  test('shows every checkpoint it was handed, not the first three', () => {
    // The bound belongs to `getAppWorkspace`, which asks for ten. A second one
    // here could only disagree with it, and the way it disagreed was silent:
    // the query was raised and the screen went on showing three.
    expect(view.activity.length).toBeGreaterThan(3);
    for (const entry of view.activity) {
      expect(markup).toContain(entry.title);
    }
    expect(markup).toContain('Recent checkpoints');
  });

  test('links to the complete global ledgers', () => {
    expect(markup).toContain('Builds');
    expect(markup).toContain('Deploys');
  });
});

describe('the App workspace', () => {
  test('every activity entry leads to the attempt it came from', () => {
    // `attempt_events` constrains every row to exactly one attempt, so every
    // entry has somewhere to go. An entry that led nowhere would be the one
    // thing on this screen a reader could not act on.
    const view = WORKSPACE_SCENARIOS.service;
    const markup = renderToStaticMarkup(
      <Workspace view={view} onNavigate={() => undefined} />,
    );

    for (const entry of view.activity) {
      expect(entry.deployId ?? entry.buildId).not.toBeNull();
      expect(markup).toContain(entry.title);
    }
    // Rendered as buttons rather than static rows — one per visible checkpoint,
    // plus the global ledger links and release link in the hero.
    const buttons = markup.split('<button').length - 1;
    expect(buttons).toBeGreaterThanOrEqual(view.activity.length);
  });

  test('an App that can receive a push offers the switch that makes it', () => {
    // §15's dispatcher and the webhook both read `apps.autoDeploy`, and until
    // now nothing anywhere could write it — the feature shipped permanently
    // off. This is the control that turns it on.
    const markup = renderToStaticMarkup(
      <Workspace
        view={WORKSPACE_SCENARIOS.service}
        onSetAutoDeploy={async () => ({ ok: true })}
      />,
    );
    expect(markup).toContain('Deploy on push: off');
  });

  test('an App no push can reach is not offered a dead switch', () => {
    // `autoDeploy: null` is the archive App: there is no repository, so there
    // is no state to be turned out of. §3's grammar disables a choice and says
    // why; this is not a choice at all, so the honest render is nothing.
    const archive = {
      ...WORKSPACE_SCENARIOS.service,
      autoDeploy: null,
    } as const satisfies WorkspaceView;

    const markup = renderToStaticMarkup(
      <Workspace view={archive} onSetAutoDeploy={async () => ({ ok: true })} />,
    );
    expect(markup).not.toContain('Deploy on push');
  });

  test('a screen wiring no acts renders no switch either', () => {
    // The same rule the reach and config editors follow: a control whose Save
    // cannot be called is worse than no control.
    expect(workspace(WORKSPACE_SCENARIOS.service)).not.toContain(
      'Deploy on push',
    );
  });

  test('a website states that it has no runtime', () => {
    // §17: the `static` adapter gets an honest empty state, and §18 puts it one
    // level down rather than disabling a tab. `kind: 'none'` carries the reason
    // with it — the difference between "nothing to show" and "nothing here to
    // show it from".
    const website = WORKSPACE_SCENARIOS.website;
    expect(website.runtime.kind).toBe('none');

    const markup = workspace(website);
    expect(markup).toContain('No runtime exists for this Component');
    expect(markup).toContain('Static files are served by the Target');
  });

  test('a job is a list of executions, not a stream', () => {
    // §17: "A job is not a stream but a list of executions. An execution
    // terminates, so it is attempt-shaped; this pipe covers services only."
    // Rendering one through the log tail would say a job has something to
    // follow, which is exactly the conflation §17 refuses.
    const job = WORKSPACE_SCENARIOS.job;
    expect(job.runtime.kind).toBe('executions');

    const markup = workspace(job);
    expect(markup).toContain('Recent runs');
    expect(markup).toContain('Execution 118');
    expect(markup).toContain('passed');
    expect(markup).toContain('failed');
    // The caption says how many are shown and where the history lives, and
    // stops there. `retained` is a page size on both backends and a retention
    // depth on `kubernetes` only, where it happens to equal the chart's
    // `successfulJobsHistoryLimit`; a Cloud Run project retains its own number
    // and reports it nowhere, so "the last 10 are kept" sent an operator
    // looking for a run `gcloud run jobs executions list` still had.
    expect(markup).toContain('Showing the last 10 runs');
    expect(markup).not.toContain('are kept');
  });

  test('runs that could not be read say so, and stay runnable', () => {
    // The state this is about is the first one an operator meets after this
    // merges: the Role granting `list` on batch has not reconciled yet, the
    // Target answers `403`, and the read fails. Collapsing that to `kind:
    // 'none'` took the Run now button off the card — the feature hiding itself
    // in exactly the state where pressing it is the diagnosis.
    const refused = {
      ...WORKSPACE_SCENARIOS.job,
      runtime: {
        kind: 'executions',
        componentId: 'component-1',
        targetId: 'target-1',
        executions: [],
        retained: 10,
        because:
          'The runs on folly could not be read: GET /apis/batch/v1/... failed with 403',
      },
    } as const satisfies WorkspaceView;

    const markup = renderToStaticMarkup(
      <Workspace view={refused} onRunJob={async () => ({ ok: true })} />,
    );
    expect(markup).toContain('Run now');
    expect(markup).toContain('could not be read');
    expect(markup).toContain('403');
    // And not the sentence for a job that has genuinely never run: nobody
    // found out whether it has.
    expect(markup).not.toContain('has not run yet');
    // Nor the caption, which counts what was shown. Nothing was.
    expect(markup).not.toContain('Showing the last');
  });

  test('running a job is offered where the runs are, and only there', () => {
    // §7 makes a job's `apply` two acts, and only the second one runs
    // anything: the header's Deploy button writes an intent that places a
    // CronJob triggered by nothing. Two buttons that both read `Run now` where
    // one deploys is the label a reader cannot recover from, so the word
    // belongs to the act that actually runs something.
    const job = WORKSPACE_SCENARIOS.job;
    const withoutAct = workspace(job);
    expect(withoutAct).toContain('Deploy');
    expect(withoutAct).not.toContain('Run now');

    const withAct = renderToStaticMarkup(
      <Workspace view={job} onRunJob={async () => ({ ok: true })} />,
    );
    expect(withAct).toContain('Run now');
  });

  describe('an App whose job is not its first Component', () => {
    // The defect this fixture exists for: the screen listed every Component and
    // could act on none but the first, so an App shaped like this one had no
    // surface for its job at all — no run list, no Run now, no config of its
    // own — while `runComponent` would have taken its pair happily.
    const view = WORKSPACE_SCENARIOS.jobBehindService;

    test('shows the runs of the Component it is showing, not of the first', () => {
      const markup = workspace(view);

      expect(markup).toContain('Recent runs');
      expect(markup).toContain('nightly-29154360');
      // And says whose runs they are. An App with a service and two jobs has
      // three runtimes, and a card headed only "Recent runs" names none of them.
      expect(markup).toContain('Output of nightly');
    });

    test('and the config of that Component, on the view that holds config', () => {
      // Config is scoped to one (Component, Target) pair and this App has
      // several, so the heading names whose keys these are — a heading that
      // said only "Config" was the same list claiming to be the App's.
      const markup = renderToStaticMarkup(
        <Workspace view={view} tab="config" />,
      );

      expect(markup).toContain('Configuration for nightly');
      expect(markup).toContain('RETENTION_DAYS');
    });

    test('offers Run now for that job', () => {
      // `{kind: 'executions'}` is what renders the control, and it was
      // unreachable for a job behind a service at any URL.
      const markup = renderToStaticMarkup(
        <Workspace view={view} onRunJob={async () => ({ ok: true })} />,
      );
      expect(markup).toContain('Run now');
    });

    test('leads with the selected Component rather than the first', () => {
      // The eyebrow over the App's name says what is being looked at, and the
      // hero underneath it is that Component's placement and release.
      expect(workspace(view)).toContain('job · nightly');
    });

    test('makes the Components list the selector, and marks the selection', () => {
      const markup = renderToStaticMarkup(
        <Workspace view={view} onSelectComponent={() => undefined} />,
      );

      // Both rows are pressable — the list is what there is to look at, so it
      // is also how another one is chosen — and exactly one is pressed.
      expect(markup.split('aria-pressed="true"').length - 1).toBe(1);
      expect(markup.split('aria-pressed="false"').length - 1).toBe(1);
      for (const component of view.components) {
        expect(markup).toContain(component.name);
      }
    });

    test('renders no selector where the screen wires no selection', () => {
      // The same rule the reach, config and auto-deploy controls follow: a
      // control whose press cannot be answered is worse than no control.
      expect(workspace(view)).not.toContain('aria-pressed');
    });

    test('states the selected Component, not the App, above its release', () => {
      // The phase pill, the address and the release beside this sentence are
      // all the job's. "Your App has no release serving yet" over an App whose
      // service is serving is a sentence about a Component, told about the App.
      const markup = workspace(view);

      expect(markup).not.toContain('Your App');
      expect(markup).toContain('nightly is deployed');
    });

    test('offers nothing to open for a Component that answers nowhere', () => {
      // A job has no address, and `normaliseUrl('')` is `''` — an `Open app`
      // anchor carrying that reloads the workspace instead of opening
      // anything, which reads as a press that did nothing.
      const markup = workspace(view);

      expect(markup).not.toContain('href=""');
      expect(markup).not.toContain('Open app');
    });

    test('still opens the address of a Component that has one', () => {
      // The other half of the same rule: the service's URL is still a link,
      // and it is still the headline the screen leads with.
      const serving: WorkspaceView = {
        ...view,
        componentId: 'component-quay-web',
        url: 'quay.apps.example',
        urlLive: true,
      };
      const markup = workspace(serving);

      expect(markup).toContain('Open app');
      expect(markup).toContain('web is live');
    });
  });

  test('a service states how far its log reaches', () => {
    // §17: `logHistory` "is how far back `since` can honestly reach... so a
    // Target never *lacks* logs; it only has a shorter memory, and the UI
    // states reach rather than disabling a tab."
    const service = WORKSPACE_SCENARIOS.service;
    expect(service.runtime.kind).toBe('stream');

    const markup = workspace(service);
    expect(markup).toContain('7 days');
    expect(markup).toContain('of history');
    // Deploys are markers on the stream, never a filter (§17) — the only shape
    // that lets a human read across a rollback boundary.
    expect(markup).toContain('never a filter');
  });

  test('a website attaches no Datastore', () => {
    // §11: a `website` cannot attach one, so the section is present and empty
    // rather than absent — it is a peer section, and hiding it would say the
    // App has no such concept.
    const markup = workspace(WORKSPACE_SCENARIOS.website);
    expect(markup).toContain('Datastores');
    expect(markup).toContain('No Datastores attached');
  });

  test('a service streams its runtime instead', () => {
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).not.toContain('No runtime exists');
    expect(markup).toContain('listening on :3000');
  });

  test('the placement states both the Target and the vessel it is on', () => {
    // The vessel is where the App is placed, not something it was created
    // with — so it is stated beside the Target it was read from, and never as
    // a setting the developer is being told they cannot change.
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).toContain(WORKSPACE_SCENARIOS.service.target);
    expect(markup).toContain(`on ${WORKSPACE_SCENARIOS.service.vessel}`);
    expect(markup).not.toContain('immutable');
  });

  test('Components and Datastores are peer sections', () => {
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).toContain('App structure');
    expect(markup).toContain('Attached resources');
  });

  test('an unattached Datastore is listed as unattached', () => {
    // §11: a Datastore is top-level and attached, never a field on an App. One
    // that exists but is not attached still exists.
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).toContain('unattached');
  });

  describe('the Datastore acts (§11)', () => {
    // The workspace states the placed Target by its **adapter**, so this is the
    // one fixture field that has to be the enum rather than the pretty label
    // the design screens carry.
    const onKubernetes = {
      ...WORKSPACE_SCENARIOS.service,
      target: 'kubernetes',
    };
    const acts = {
      onCreateDatastore: async () => ({ ok: true }) as const,
      onAttachDatastore: async () => ({ ok: true }) as const,
      onDetachDatastore: async () => ({ ok: true }) as const,
      onDestroyDatastore: async () => ({ ok: true }) as const,
    };

    test('offers none of them when the screen wires none', () => {
      // The both-or-neither rule: `Attach Datastore` and its per-row twin were
      // buttons with no handler behind them for the whole life of this card,
      // and a control that does nothing on press reads as a broken feature
      // rather than an absent one.
      const markup = workspace(onKubernetes);
      expect(markup).not.toContain('Create Datastore');
      expect(markup).not.toContain('>Attach<');
      expect(markup).not.toContain('>Detach<');
      expect(markup).not.toContain('>Destroy<');
    });

    test('offers create on a kubernetes placement, with the row acts', () => {
      const markup = renderToStaticMarkup(
        <Workspace view={onKubernetes} {...acts} />,
      );
      expect(markup).toContain('Create Datastore');
      // Attach or detach, never both on one row: `primary` is attached and
      // `cache` is not, so the section shows exactly one of each.
      expect(markup).toContain('>Attach<');
      expect(markup).toContain('>Detach<');
      expect(markup).toContain('>Destroy<');
    });

    test('offers no create where the adapter cannot provision one', () => {
      // By adapter type, never by what the adapter claims to serve: the cloud
      // adapter advertises both engines and throws UNIMPLEMENTED from every
      // verb, so asking it by engine would render a form whose every
      // submission is refused. The row acts stay — those act on rows.
      const markup = renderToStaticMarkup(
        <Workspace
          view={{ ...WORKSPACE_SCENARIOS.service, target: 'cloudrun' }}
          {...acts}
        />,
      );
      expect(markup).not.toContain('Create Datastore');
      expect(markup).toContain('>Detach<');
    });

    test('states the variable each engine arrives on, and asks for neither', () => {
      // Fixed by engine, so there is no field for it anywhere and this line is
      // where a developer finds out what their container will be handed.
      const markup = renderToStaticMarkup(
        <Workspace view={onKubernetes} {...acts} />,
      );
      expect(markup).toContain('DATABASE_URL');
      expect(markup).toContain('REDIS_URL');
      expect(markup).not.toContain('datastore-variable');
    });

    test('a provisioning Datastore reads as provisioning, not as broken', () => {
      const markup = workspace(WORKSPACE_SCENARIOS.service);
      expect(markup).toContain('WAITING');
      expect(markup).toContain('Waiting for 1 shard to report ready');
    });
  });

  describe('the timeline', () => {
    const view = WORKSPACE_SCENARIOS.service;
    const markup = workspace(view);

    test('is a sequence, joined by a rule its markers sit on', () => {
      // Stacked rows said these were unrelated events that happened to be near
      // each other. The connector is what carries the reading down the column,
      // and it is the difference between a list and a timeline.
      expect(markup).toContain('Recent checkpoints');
      expect(markup).toContain('<ol');
    });

    test('says which stage every checkpoint belongs to', () => {
      // A column of red cannot say whether the image or its placement is the
      // problem unless each row carries its lane. Build and Deploy are two
      // stages, and this is where that is easiest to lose.
      const text = words(markup);
      for (const entry of view.activity) {
        expect(text).toContain(entry.kind);
        expect(text).toContain(entry.title);
      }
    });
  });
});

/**
 * What the App surface says now that the read model carries it.
 *
 * Every claim below is about a fact `getAppWorkspace` had in hand and dropped
 * on the floor — the commit, the instant, the failure reason, the drift, which
 * prerequisite is unmet. The screen rendered a phase pill over all of them, so
 * a drifted App read "is live" and a failed one read "has no release serving
 * yet" with no reason and no evidence.
 */
describe('the App workspace states what the release did', () => {
  const service = WORKSPACE_SCENARIOS.service;

  test('the hero dates the release and names the commit it shipped', () => {
    const markup = workspace({
      ...service,
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      when: '8m ago',
      at: '2026-07-28T13:00:00.000Z',
    });

    // Shortened to git's own seven, with the whole value on the title so a
    // hover answers what the ellipsis ate.
    expect(markup).toContain('a1b2c3d');
    expect(markup).toContain('2026-07-28T13:00:00.000Z');
  });

  test('a red release names its reason on the App, not only on the attempt', () => {
    const markup = workspace({
      ...service,
      phase: 'FAILED',
      urlLive: false,
      diagnosis: {
        reason: 'STARTUP_FAILED',
        blame: 'developer',
        detail: 'The container exits immediately on start.',
        evidence: null,
      },
    });

    expect(markup).toContain('STARTUP_FAILED');
    expect(markup).toContain('The container exits immediately on start.');
  });

  test('a drifted release says so instead of reading as live', () => {
    // §6 calls drift "information, not an alarm" — and until now the App it is
    // about was the one screen that could not report it.
    const markup = workspace({
      ...service,
      drift: {
        since: '2h ago',
        at: '2026-07-28T13:00:00.000Z',
        observedDigest: 'sha256:0badc0ffee',
        detail: null,
      },
    });

    expect(markup).toContain('DRIFTED');
    expect(markup).toContain('since 2h ago');
  });

  test('an unmet prerequisite is named rather than counted', () => {
    const markup = workspace({
      ...service,
      prerequisitesMet: false,
      unmetPrerequisites: [
        {
          name: 'DELIVERY_OPERATOR',
          met: false,
          detail: 'No delivery operator is installed in this cluster.',
        },
      ],
    });

    expect(markup).toContain('1 prerequisite unmet');
    expect(markup).toContain(
      'No delivery operator is installed in this cluster.',
    );
  });

  test('a Component row carries its own placement, not the selection’s', () => {
    const markup = workspace({
      ...service,
      components: [
        {
          ...service.components[0]!,
          target: 'driftwood/kubernetes',
          url: 'beacon.apps.example',
          urlLive: true,
          when: '8m ago',
        },
      ],
    });

    expect(markup).toContain('driftwood/kubernetes');
  });
});

describe('the App workspace has views rather than one column', () => {
  const service = WORKSPACE_SCENARIOS.service;

  test('the strip names them, and Overview is where an arrival lands', () => {
    const markup = workspace(service);

    expect(markup).toContain('Releases');
    expect(markup).toContain('role="tablist"');
    // The hero is above the strip: whether the App is up is not a tab you can
    // be on the wrong one of.
    expect(markup.indexOf('is live')).toBeLessThan(
      markup.indexOf('role="tablist"'),
    );
  });

  test('config is behind its own view, and off the Overview', () => {
    expect(workspace(service)).not.toContain('value is write-only');
  });

  test('the live tail follows, and says what it dropped', () => {
    // `app.tsx` appends every socket page forever. Without a cap the pane grew
    // the page without bound while the newest line sat off-screen.
    const chatty = workspace({
      ...service,
      runtime: {
        kind: 'stream',
        componentId: 'component-beacon-web',
        targetId: 'target-metal',
        reach: '7 days',
        lines: Array.from({ length: 2_050 }, (_, index) => ({
          text: `line ${index}`,
        })),
      },
    });

    expect(chatty).toContain('Showing the last 2000 lines');
    expect(chatty).not.toContain('line 0\n');
    // Following is what gives the pane a bottom to scroll to.
    expect(chatty).toContain('max-h-[420px]');
  });

  test('no button on this screen does nothing when it is pressed', () => {
    // `SectionHeader` renders its verb whether or not a handler was passed, so
    // these two read as broken features rather than absent ones.
    const markup = workspace(service);

    expect(markup).not.toContain('Add Component');
    expect(markup).not.toContain('Attach Datastore');
  });
});

/**
 * The Targets surface (§13).
 *
 * Two claims, and the second is the one that used to have no screen at all:
 * a Target says what was *checked*, not only what is broken, and a Target the
 * manifest seeded but nobody connected is something an operator can finish
 * here rather than only in Git.
 */
describe('the Targets surface', () => {
  const targets = (pending: Parameters<typeof TargetList>[0]['pending'] = []) =>
    renderToStaticMarkup(
      <TargetList
        targets={TARGET_LIST}
        pending={pending}
        vessels={VESSEL_LIST}
        connecting={false}
        error={null}
        onConnect={() => undefined}
      />,
    );

  test('shows the whole checklist, met rows included', () => {
    const markup = targets();
    // Every prerequisite a cluster is assessed against, not only the failures:
    // "why can I not deploy here" is answered by what was checked.
    for (const item of [
      'DELIVERY_OPERATOR',
      'CHART_SOURCE',
      'WRITABLE_STORE',
      'OIDC_FEDERATION',
      'VESSEL',
      'CHART_CONTRACT',
    ]) {
      expect(markup).toContain(item);
    }
    expect(markup).toContain('no Flux controller answers in this cluster');
  });

  test('groups real Target workflows into ruled Settings provider rows', () => {
    const markup = renderToStaticMarkup(
      <TargetList
        targets={TARGET_LIST}
        pending={[]}
        vessels={VESSEL_LIST}
        connecting={false}
        error={null}
        onConnect={() => undefined}
        embedded
      />,
    );
    expect(markup).toContain('Google Cloud');
    expect(markup).toContain('Kubernetes');
    expect(markup).toContain('Target suggestion order');
    expect(markup).toContain('Disconnect');
    expect(markup).not.toContain('<h1');
  });

  test('offers to finish a Target the manifest seeded and nobody connected', () => {
    const markup = targets([
      {
        kind: 'gcp-project',
        vessel: 'a-project',
        surfaces: ['cloudrun', 'static'],
        proposal: {
          carriedFrom: 'other/cloudrun',
          region: 'somewhere',
          runEndpoint: 'https://run.example.test',
          hostingEndpoint: 'https://hosting.example.test',
        },
      },
    ]);

    expect(markup).toContain('Waiting to be connected');
    expect(markup).toContain('a-project');
    expect(markup).toContain('Finish setup');
  });

  test('says nothing about connecting when there is nothing left to connect', () => {
    expect(targets()).not.toContain('Waiting to be connected');
  });

  test('a connected cluster can be corrected without submitting the whole manifest', () => {
    // 52's first criterion. The connect form was reachable only from an
    // unconfigured seed, so the gateway, the authenticated edge, the config
    // store and the address a record points at were editable nowhere in the
    // product once a Target existed — the procedure was to hand-write the whole
    // installation document for a change of three fields.
    expect(targets()).toContain('Edit connection');
  });

  test('a Target whose row and manifest entry disagree says so, in paths', () => {
    const markup = words(targets());
    expect(markup).toContain(
      'connection.chartValues.platform.gateway.name, connection.chartValues.platform.gateway.namespace',
    );
    // The row wins, and the sentence has to say which way round that is: a
    // restart leaves the correction alone and saving Settings does not.
    expect(markup).toContain('a restart leaves it alone');
    // Paths, never values — the same promise `diffManifestPaths` makes, kept
    // all the way onto the screen.
    expect(markup).not.toContain('spindrift-apps');
  });

  /** One card at a time, because the two claims below are about one card each. */
  const card = (id: string) =>
    renderToStaticMarkup(
      <TargetList
        targets={TARGET_LIST.filter((target) => target.id === id)}
        pending={[]}
        vessels={VESSEL_LIST}
        connecting={false}
        error={null}
        onConnect={() => undefined}
      />,
    );

  test('a surface on a vessel the installation is built on offers neither act', () => {
    // That boundary reconciles from the mounted declaration on every boot, so
    // an edit made here would survive exactly until the next restart — and a
    // disconnect is refused one layer down, because neither pointer is a
    // foreign key and nothing else would stop it.
    const markup = words(card('target-primary'));
    expect(markup).not.toContain('Edit connection');
    expect(markup).not.toContain('Disconnect');
    // And the sentence saying why, rather than a disabled button saying nothing.
    expect(markup).toContain('where this control plane runs');
    expect(markup).toContain('cannot be disconnected');
  });

  test('an ordinary Target keeps both acts', () => {
    // The other side of the same claim: the lock is by role, not by screen.
    const markup = words(card('target-secondary'));
    expect(markup).toContain('Edit connection');
    expect(markup).toContain('Disconnect');
    expect(markup).not.toContain('cannot be disconnected');
  });

  test('the boundaries carry a checklist of their own, and say which they are', () => {
    const markup = words(targets());
    expect(markup).toContain('Boundaries this installation is built on');
    // The four the home vessel exists to hold. None of them belongs to a
    // Target, and none is asked of an app vessel.
    for (const item of [
      'SOURCE_BUCKET',
      'SECRET_STORE',
      'SIGNER_KEY',
      'ARTIFACTS_PROJECT',
    ]) {
      expect(markup).toContain(item);
    }
    expect(markup).toContain('home vessel');
    expect(markup).toContain('where this control plane runs');
    // Red where a row failed — a boundary's health is every catalogued row met.
    expect(markup).toContain('unhealthy');
  });

  test('an unmet row carries the change that clears it, and where it goes', () => {
    // §13's checklist stated the diagnosis and stopped. What an operator needs
    // next is the fix, so the row carries it — with its destination, because a
    // stanza with no path is a snippet.
    const markup = words(targets());
    expect(markup).toContain('Remediation');
    expect(markup).toContain('google_storage_bucket');
    expect(markup).toContain('terraform/projects/cloud/storage.tf');
    expect(markup).toContain('Copy');
    expect(markup).toContain('Open a pull request');
    // And the promise the act keeps: applying is what clears the row, and the
    // standing check is what notices.
    expect(markup).toContain('Spindrift changes nothing here');
  });

  test('a row with no generated change says so rather than showing an empty box', () => {
    // The same found-versus-unavailable split `cloud-discovery.ts` keeps: an
    // empty disclosure would say a change exists and is empty.
    const markup = words(targets());
    expect(markup).toContain('No generated remediation');
    expect(markup).toContain('cannot be changed afterwards');
    // A row cleared somewhere other than Terraform names the tree that owns it
    // rather than offering a pull request against the wrong one.
    expect(markup).toContain('GitOps tree rather than Terraform');
  });

  test('a boundary with no Terraform root is told so, never given a path', () => {
    const rootless = VESSEL_LIST.map((vessel) => ({
      ...vessel,
      prerequisites: vessel.prerequisites.map((item) =>
        item.remediation?.kind === 'generated'
          ? {
              ...item,
              remediation: {
                ...item.remediation,
                destination: {
                  kind: 'absent' as const,
                  vessel: vessel.name,
                  file: 'storage.tf',
                },
              },
            }
          : item,
      ),
    }));
    const markup = words(
      renderToStaticMarkup(
        <TargetList
          targets={TARGET_LIST}
          pending={[]}
          vessels={rootless}
          connecting={false}
          error={null}
          onConnect={() => undefined}
        />,
      ),
    );
    expect(markup).toContain('has no Terraform root');
    expect(markup).toContain('what one would contain');
    // There is nowhere to open it, so the act is not offered — and the stanza
    // still is, because copying it is the move that remains.
    expect(markup).not.toContain('Open a pull request');
    expect(markup).toContain('google_storage_bucket');
  });

  test('a boundary nobody has been past says so rather than reading as passed', () => {
    // §18's rule in reverse: a snapshot has to say when, and never-assessed is
    // a different state from assessed-and-everything-met.
    const markup = words(
      renderToStaticMarkup(
        <TargetList
          targets={TARGET_LIST}
          pending={[]}
          vessels={VESSEL_LIST.map((vessel) => ({
            ...vessel,
            inspectedAt: null,
          }))}
          connecting={false}
          error={null}
          onConnect={() => undefined}
        />,
      ),
    );
    expect(markup).toContain('never inspected');
  });
});

describe('changing how a Component is reached (§9)', () => {
  const view = WORKSPACE_SCENARIOS.service;

  test('reach is not editable where no act is wired', () => {
    // The fixture screens render this view with no acts. A form whose Save
    // cannot be called is worse than no form.
    expect(workspace(view)).not.toContain('Save reach');
  });

  test('the affordance is on the Component that has one', () => {
    const markup = renderToStaticMarkup(
      <Workspace
        view={view}
        onSetReach={async () => ({ ok: true, pendingRelease: [] })}
      />,
    );
    expect(markup).toContain('Reach');
  });

  test('the edit says it takes effect on the next Deploy, not on the one serving', () => {
    const markup = words(
      renderToStaticMarkup(
        <ReachEditor
          component={view.components[0]!}
          onSetReach={async () => ({ ok: true, pendingRelease: [] })}
          onDone={() => undefined}
        />,
      ),
    );

    // §9 keeps exposure out of the mutable-in-place category, and the App chart
    // renders the route and the filter from values written at deploy time — so
    // the one thing this form must never read as is a toggle that took effect.
    expect(markup).toContain(
      'takes effect on the next Deploy rather than on the one that is serving',
    );
    // Both halves of §9's grid, in the words the creation flow uses — the same
    // constants, so a developer meets the decision once.
    for (const cell of ['none', 'private', 'public', 'proxy']) {
      expect(markup).toContain(cell);
    }
  });
});

describe('editing config from the workspace (§10)', () => {
  const view = WORKSPACE_SCENARIOS.service;
  /** Config is its own view of the App now, so the assertions open it. */
  const config = (v: WorkspaceView) =>
    renderToStaticMarkup(<Workspace view={v} tab="config" />);

  test('every configured key is shown, and nothing about its value is', () => {
    const markup = config(view);
    for (const key of view.configKeys) {
      expect(markup).toContain(key);
    }
    expect(markup).toContain('value is write-only');
    // The consequence, stated rather than hidden: this is the same posture
    // `deployChange`'s own comment takes server-side, kept on the screen.
    expect(markup).toContain(
      'redeploys what is running under a new configVersion',
    );
  });

  test('the affordance is on the section only where an act is wired', () => {
    // No form whose Save cannot be called — the same rule §9's Reach card
    // states above.
    expect(config(view)).not.toContain('Set variable');

    const markup = renderToStaticMarkup(
      <Workspace
        view={view}
        tab="config"
        onSetConfig={async () => ({
          ok: true,
          written: [],
          removed: [],
          notDeployed: null,
        })}
      />,
    );
    expect(markup).toContain('Set variable');
  });

  test('pressing Delete on a key dispatches setConfig’s removal shape, and nothing else', () => {
    // Called directly rather than clicked through a mounted tree, for the
    // same reason `DeleteAppButton`'s own test in `app-list-identity.test.tsx`
    // is: what is under test is which value the handler closes over, and
    // `renderToStaticMarkup` — this file's usual depth — cannot click
    // anything (see this file's own header).
    const calls: {
      entries: readonly { key: string; value: string }[];
      removals: readonly string[];
    }[] = [];
    const onSetConfig = async (change: {
      entries: readonly { key: string; value: string }[];
      removals: readonly string[];
    }) => {
      calls.push(change);
      return {
        ok: true as const,
        written: [],
        removed: change.removals,
        notDeployed: null,
      };
    };

    const button = DeleteConfigVarButton({
      configKey: 'DATABASE_URL',
      onSetConfig,
      onError: () => undefined,
    });
    (button.props as { onClick: () => void }).onClick();

    // The exact shape `setConfig` takes: the key named, nothing about the
    // keys left alone — a removal never restates a value it cannot read.
    expect(calls).toEqual([{ entries: [], removals: ['DATABASE_URL'] }]);
  });
});
