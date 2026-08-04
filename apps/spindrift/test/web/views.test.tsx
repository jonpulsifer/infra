/**
 * The view assertions Tasks 37, 39, and 40 name, and the rules around them.
 *
 * These are rendered to static markup rather than driven in a browser. That is
 * the right depth for what is being claimed: every rule under test is a
 * statement about **what appears on the screen in a given state**, and none of
 * them is about interaction. A test that needed a click would be testing Radix.
 *
 * The screens are rendered from `demo/scenarios.ts`, which is the placeholder
 * data. When the query commands replace it these tests keep their subject —
 * they assert over `DeployView` and `WorkspaceView`, and those types are the
 * contract the queries will have to meet.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeployView, WorkspaceView } from '../../src/web/model.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { ReachEditor, Workspace } from '../../src/web/views/apps/workspace.tsx';
import { Gate } from '../../src/web/views/auth/gate.tsx';
import { CredentialSettingsView } from '../../src/web/views/auth/settings.tsx';
import { RepositoryList } from '../../src/web/views/repos/list.tsx';
import { TargetList } from '../../src/web/views/targets/list.tsx';
import {
  BUILD_ATTEMPT,
  DEPLOY_SCENARIOS,
  TARGET_LIST,
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
            connected: false,
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

  test('shows only the three newest checkpoints', () => {
    for (const entry of view.activity.slice(0, 3)) {
      expect(markup).toContain(entry.title);
    }
    for (const entry of view.activity.slice(3)) {
      expect(markup).not.toContain(entry.title);
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

    for (const entry of view.activity.slice(0, 3)) {
      expect(entry.deployId ?? entry.buildId).not.toBeNull();
      expect(markup).toContain(entry.title);
    }
    // Rendered as buttons rather than static rows — one per visible checkpoint,
    // plus the global ledger links and release link in the hero.
    const buttons = markup.split('<button').length - 1;
    expect(buttons).toBeGreaterThanOrEqual(Math.min(view.activity.length, 3));
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
    // The retention depth is stated, and stated as configured rather than
    // stored — §17 fixes the platform asymmetry "by rendering a larger history
    // limit, not by storing logs".
    expect(markup).toContain('last 10 executions');
    expect(markup).toContain('configured on the Target');
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

  test('the vessel is shown and marked immutable', () => {
    // §14: chosen once, at creation. A developer who does not find the setting
    // will go looking for it, so the absence is labelled.
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).toContain(WORKSPACE_SCENARIOS.service.vessel);
    expect(markup).toContain('immutable vessel');
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
        name: 'a-project',
        targets: ['a-project-cloudrun', 'a-project-static'],
        proposal: {
          carriedFrom: 'other-cloudrun',
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
