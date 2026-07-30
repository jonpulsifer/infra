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
import {
  DEPLOY_SCENARIOS,
  WORKSPACE_SCENARIOS,
} from '../../src/web/demo/scenarios.ts';
import type { DeployView, WorkspaceView } from '../../src/web/model.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import { Workspace } from '../../src/web/views/apps/workspace.tsx';
import { Gate } from '../../src/web/views/auth/gate.tsx';
import { CredentialSettingsView } from '../../src/web/views/auth/settings.tsx';
import { RepositoryList } from '../../src/web/views/repos/list.tsx';

const deploy = (view: DeployView) =>
  renderToStaticMarkup(<DeployDetail view={view} />);

const workspace = (view: WorkspaceView) =>
  renderToStaticMarkup(<Workspace view={view} />);

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

  test('collects reviewed scope configuration after authorization', () => {
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
    expect(markup).toContain('Component kind');
    expect(markup).toContain('Build frontend');
    expect(markup).toContain('Watch paths');
    expect(markup).toContain('Open configuration PR');
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
      const opened = deploy(view).includes(view.build.steps[0]!.name);
      expect(opened).toBe(
        view.build.status === 'failed' || view.build.status === 'running',
      );
    });
  }

  test('a green build stays collapsed even when the deploy failed', () => {
    // The case that makes the rule above worth having: the build succeeded and
    // the cluster could not pull what it produced.
    const view = DEPLOY_SCENARIOS.imageUnpullable;
    expect(view.build.status).toBe('done');

    const markup = deploy(view);
    expect(markup).toContain('ARTIFACT_UNAVAILABLE');
    expect(markup).toContain('platform');
    expect(markup).not.toContain('compiled successfully');
    expect(markup).toContain('Deploy log · failed');
    expect(markup).toContain('controller accepted the deploy');
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
});

describe('the App workspace', () => {
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
});
