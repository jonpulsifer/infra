// Screens rendered to static markup from `test/fixtures/scenarios.ts`. Each
// rule is about what appears in a given state, so none needs a click.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DeployLedgerItem,
  DeployView,
  WorkspaceView,
} from '../../src/commands/views.ts';
import { logos } from '../../src/web/client/logos/index.ts';
import { DeployDetail } from '../../src/web/views/apps/deploy-detail.tsx';
import {
  AUTH_NOTE,
  REACH_NOTE,
} from '../../src/web/views/apps/new/summary.tsx';
import {
  DeleteConfigVarButton,
  NewComponentForm,
  PlacementEditor,
  ReachEditor,
  SupplyDemand,
  Workspace,
} from '../../src/web/views/apps/workspace.tsx';
import { Gate } from '../../src/web/views/auth/gate.tsx';
import { CredentialSettingsView } from '../../src/web/views/auth/settings.tsx';
import { DatastoreLedger } from '../../src/web/views/operations/datastores.tsx';
import { Overview } from '../../src/web/views/operations/overview.tsx';
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

/** The rendered text, so a sentence split across spans is asserted whole. */
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
    onConnect: () => undefined,
    onRefresh: () => undefined,
  };
  const setup = {
    action: 'https://github.example.test/settings/apps/new?state=sealed-state',
    manifest: '{"name":"spindrift-example"}',
  };

  test('uses a provider row and no second page heading inside Settings', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[]}
        connector={{ state: 'unauthorized', setup }}
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

  test('starts with the create-the-App form and renders no key material', () => {
    const markup = renderToStaticMarkup(
      <RepositoryList
        repos={[]}
        options={[]}
        connector={{ state: 'unauthorized', setup }}
        connecting={false}
        error={null}
        openedPullRequest={null}
        {...actions}
      />,
    );
    expect(markup).toContain('Create the App on');
    expect(markup).toContain(
      'action="https://github.example.test/settings/apps/new?state=sealed-state"',
    );
    expect(markup).toContain('name="manifest"');
    expect(markup).not.toContain('PRIVATE KEY');
  });

  // The detector reads each of these fields from the repository.
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
          slug: 'spindrift-example',
          appId: '1234567',
          installUrl:
            'https://github.example.test/apps/spindrift-example/installations/new',
        }}
        connecting={false}
        error={null}
        openedPullRequest={null}
        {...actions}
      />,
    );
    expect(markup).toContain('Speaking as spindrift-example');
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
    const view = DEPLOY_SCENARIOS.live;
    expect(view.build?.runnerAdapter).toBe('github-actions');

    const markup = deploy(view);
    // `Logo` is `aria-hidden`, so the platform is also named in words.
    expect(words(markup)).toContain('GitHub Actions');
    expect(markup).toContain(view.build!.runner);
    expect(markup).toContain(logos.github);
  });

  test('a release that was never built names no builder at all', () => {
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
      // A failed deploy never changes exposure, so the previous release is up.
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
      // Radix leaves closed content unmounted, so a step name appears only when
      // the build log is open.
      expect(view.build).not.toBeNull();
      const build = view.build!;
      const opened = deploy(view).includes(build.steps[0]!.name);
      expect(opened).toBe(
        build.status === 'failed' || build.status === 'running',
      );
    });
  }

  test('a green build stays collapsed even when the deploy failed', () => {
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
    const view = DEPLOY_SCENARIOS.imageUnpullable;
    const text = words(deploy(view));

    expect(text).toContain('1 Build · done');
    expect(text).toContain('2 Deploy · failed');
  });

  test('shows the deploy stage even when the Build row is red', () => {
    // Supply-chain admission produces this pair: the runner pushed an image,
    // the artifact was refused, and the Deploy over it failed too.
    const view: DeployView = {
      ...DEPLOY_SCENARIOS.imageUnpullable,
      build: { ...DEPLOY_SCENARIOS.buildFailed.build, status: 'failed' },
    };
    const text = words(deploy(view));

    expect(text).toContain('2 Deploy · failed');
    expect(deploy(view)).toContain('controller accepted the deploy');
  });

  test('but not when nothing is serving', () => {
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
  // With `debug` null and no `log` event, `getDeployDetail` projects no
  // evidence and a null deploy log.
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
    expect(markup).not.toContain('what Spindrift found');
  });

  test('says the deploy log is live status rather than inventing a line', () => {
    expect(markup).toContain('no text line has arrived yet');
    expect(markup).not.toContain('{}');
  });
});

describe('the build stage, on the transcript it carries', () => {
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
    // Asserted on the red build: the green build's drawer is shut.
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
    expect(markup).not.toContain('compiled successfully');
  });

  test('carries no diagnosis', () => {
    expect(markup).not.toContain('What Spindrift found');
  });
});

describe('a runner that withholds log text', () => {
  const markup = deploy(DEPLOY_SCENARIOS.building);

  test('labels the checklist as the live view', () => {
    expect(DEPLOY_SCENARIOS.building.build.fidelity).toBe('LIVE_STATUS');
    expect(markup).toContain('LIVE_STATUS');
    expect(markup).toContain('the live view');
  });

  test('shows the checklist it just called live', () => {
    expect(markup).toContain('export image');
  });

  test('sends the reader where the text is actually being written', () => {
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
    const withoutLink = deploy({
      ...DEPLOY_SCENARIOS.building,
      build: { ...DEPLOY_SCENARIOS.building.build, runUrl: null },
    } as DeployView);
    expect(withoutLink).toContain('the live view');
    expect(withoutLink).not.toContain('Open the run');
  });
});

describe('a release that was extracted rather than built', () => {
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
    expect(markup).toContain('Artifact');
    expect(markup).toContain(view.artifactDigest!);
  });
});

describe('an attempt that is only a Build', () => {
  // Deploy with nothing deployable writes only a PENDING Build, and this is the
  // screen the press lands on.
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
    expect(words(markup)).not.toContain('2 Deploy ·');
  });
});

describe('the compact App history', () => {
  const view = WORKSPACE_SCENARIOS.service;
  const markup = renderToStaticMarkup(
    <Workspace view={view} onNavigate={() => undefined} />,
  );

  test('shows every checkpoint it was handed, not the first three', () => {
    // `getAppWorkspace` owns the bound, so the screen applies none of its own.
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
    // `attempt_events` ties every row to exactly one attempt.
    const view = WORKSPACE_SCENARIOS.service;
    const markup = renderToStaticMarkup(
      <Workspace view={view} onNavigate={() => undefined} />,
    );

    for (const entry of view.activity) {
      expect(entry.deployId ?? entry.buildId).not.toBeNull();
      expect(markup).toContain(entry.title);
    }
    // One button per checkpoint, plus the ledger links and the release link.
    const buttons = markup.split('<button').length - 1;
    expect(buttons).toBeGreaterThanOrEqual(view.activity.length);
  });

  test('an App that can receive a push offers the switch that makes it', () => {
    const markup = renderToStaticMarkup(
      <Workspace
        view={WORKSPACE_SCENARIOS.service}
        onSetAutoDeploy={async () => ({ ok: true })}
      />,
    );
    expect(markup).toContain('Deploy on push: off');
  });

  test('an App no push can reach is not offered a dead switch', () => {
    // `autoDeploy: null` is an archive App, which has no repository to push to.
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
    expect(workspace(WORKSPACE_SCENARIOS.service)).not.toContain(
      'Deploy on push',
    );
  });

  test('a website states that it has no runtime', () => {
    const website = WORKSPACE_SCENARIOS.website;
    expect(website.runtime.kind).toBe('none');

    const markup = workspace(website);
    expect(markup).toContain('No runtime exists for this Component');
    expect(markup).toContain('Static files are served by the Target');
  });

  test('a job is a list of executions, not a stream', () => {
    const job = WORKSPACE_SCENARIOS.job;
    expect(job.runtime.kind).toBe('executions');

    const markup = workspace(job);
    expect(markup).toContain('Recent runs');
    expect(markup).toContain('Execution 118');
    expect(markup).toContain('passed');
    expect(markup).toContain('failed');
    // `retained` is a retention depth only on `kubernetes`; Cloud Run keeps its
    // own number and reports it nowhere, so the caption says nothing about it.
    expect(markup).toContain('Showing the last 10 runs');
    expect(markup).not.toContain('are kept');
  });

  test('runs that could not be read say so, and stay runnable', () => {
    // A `403` on the runs read keeps Run now on the card, because pressing it
    // is the diagnosis.
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
    // Whether the job has ever run is unknown.
    expect(markup).not.toContain('has not run yet');
    expect(markup).not.toContain('Showing the last');
  });

  test('running a job is offered where the runs are, and only there', () => {
    // The header's Deploy places the job without running it, so `Run now`
    // belongs only to the act that runs it.
    const job = WORKSPACE_SCENARIOS.job;
    const withoutAct = workspace(job);
    expect(withoutAct).toContain('Deploy');
    expect(withoutAct).not.toContain('Run now');

    const withAct = renderToStaticMarkup(
      <Workspace view={job} onRunJob={async () => ({ ok: true })} />,
    );
    expect(withAct).toContain('Run now');
    expect(withAct).toContain('Add parameter');
    expect(withoutAct).not.toContain('Add parameter');
  });

  test('restarting a service is offered where its output is, and only there', () => {
    // A job has no process to restart, whatever the screen wires.
    const service = WORKSPACE_SCENARIOS.service;
    expect(service.runtime.kind).toBe('stream');
    expect(workspace(service)).not.toContain('Restart');

    const withAct = renderToStaticMarkup(
      <Workspace
        view={service}
        onRestartService={async () => ({ ok: true })}
      />,
    );
    expect(withAct).toContain('Restart');

    const job = renderToStaticMarkup(
      <Workspace
        view={WORKSPACE_SCENARIOS.job}
        onRestartService={async () => ({ ok: true })}
      />,
    );
    expect(job).not.toContain('Restart');
  });

  describe('an App whose job is not its first Component', () => {
    const view = WORKSPACE_SCENARIOS.jobBehindService;

    test('shows the runs of the Component it is showing, not of the first', () => {
      const markup = workspace(view);

      expect(markup).toContain('Recent runs');
      expect(markup).toContain('nightly-29154360');
      expect(markup).toContain('Output of nightly');
    });

    test('and the config of that Component, on the view that holds config', () => {
      // Config is scoped to one (Component, Target) pair, so the heading names
      // the Component.
      const markup = renderToStaticMarkup(
        <Workspace view={view} tab="config" />,
      );

      expect(markup).toContain('Configuration for nightly');
      expect(markup).toContain('RETENTION_DAYS');
    });

    test('offers Run now for that job', () => {
      // Only an `executions` runtime renders the control.
      const markup = renderToStaticMarkup(
        <Workspace view={view} onRunJob={async () => ({ ok: true })} />,
      );
      expect(markup).toContain('Run now');
    });

    test('leads with the selected Component rather than the first', () => {
      expect(workspace(view)).toContain('job · nightly');
    });

    test('makes the diagram the selector, and marks the selection', () => {
      const markup = renderToStaticMarkup(
        <Workspace view={view} onSelectComponent={() => undefined} />,
      );

      expect(markup.split('aria-pressed="true"').length - 1).toBe(1);
      expect(markup.split('aria-pressed="false"').length - 1).toBe(1);
      for (const component of view.components) {
        expect(markup).toContain(component.name);
      }
    });

    test('and states the chosen one beneath the picture', () => {
      const markup = renderToStaticMarkup(
        <Workspace view={view} onSelectComponent={() => undefined} />,
      );
      expect(markup).toContain('Reach');
      expect(markup).toContain('Artifact');
      expect(markup).toContain('Placement');
    });

    test('renders no selector where the screen wires no selection', () => {
      expect(workspace(view)).not.toContain('aria-pressed');
    });

    test('states the selected Component, not the App, above its release', () => {
      const markup = workspace(view);

      expect(markup).not.toContain('Your App');
      expect(markup).toContain('nightly is deployed');
    });

    test('offers nothing to open for a Component that answers nowhere', () => {
      // A job has no address, and an anchor with `href=""` reloads the page.
      const markup = workspace(view);

      expect(markup).not.toContain('href=""');
      expect(markup).not.toContain('Open app');
    });

    test('still opens the address of a Component that has one', () => {
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
    const service = WORKSPACE_SCENARIOS.service;
    expect(service.runtime.kind).toBe('stream');

    const markup = workspace(service);
    expect(markup).toContain('7 days');
    expect(markup).toContain('of history');
    expect(markup).toContain('never a filter');
  });

  test('a service streams its runtime instead', () => {
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).not.toContain('No runtime exists');
    expect(markup).toContain('listening on :3000');
  });

  test('the placement states both the Target and the vessel it is on', () => {
    const markup = workspace(WORKSPACE_SCENARIOS.service);
    expect(markup).toContain(WORKSPACE_SCENARIOS.service.target);
    expect(markup).toContain(`on ${WORKSPACE_SCENARIOS.service.vessel}`);
    expect(markup).not.toContain('immutable');
  });

  test('Components own the width of the Config tab', () => {
    const markup = renderToStaticMarkup(
      <Workspace view={WORKSPACE_SCENARIOS.service} tab="config" />,
    );
    expect(markup).toContain('App structure');
    // Datastore lifetime acts belong to the ledger.
    expect(markup).not.toContain('Attached resources');
    expect(markup).not.toContain('Create Datastore');
    expect(markup).not.toContain('>Detach<');
    expect(markup).not.toContain('>Destroy<');
  });

  describe('the Datastore line (§11)', () => {
    test('names what this App reads through, and offers no attach unwired', () => {
      const markup = renderToStaticMarkup(
        <Workspace view={WORKSPACE_SCENARIOS.service} tab="config" />,
      );
      expect(markup).toContain('Datastores');
      expect(markup).toContain('DATABASE_URL');
      expect(markup).not.toContain('>Attach<');
    });

    test('offers the unattached ones, and only those', () => {
      // `attachDatastore` refuses a Datastore attached to another App.
      const markup = renderToStaticMarkup(
        <Workspace
          view={WORKSPACE_SCENARIOS.service}
          tab="config"
          onAttachDatastore={async () => ({ ok: true }) as const}
        />,
      );
      expect(markup).toContain('>Attach<');
      expect(markup).toContain('attach-datastore');
      expect(markup).toContain('datastore-beacon-cache');
      expect(markup).not.toContain('value="datastore-beacon-primary"');
    });

    test('a website has nothing to say and says nothing', () => {
      const markup = workspace(WORKSPACE_SCENARIOS.website);
      expect(markup).not.toContain('attach-datastore');
    });
  });

  describe('the Datastore ledger attaches, with the App named (§11)', () => {
    const store = {
      id: 'datastore-cache',
      name: 'cache',
      engine: 'valkey',
      provenance: 'managed',
      attachedTo: null,
      target: 'driftwood / Metal',
      vesselId: 'vessel-driftwood',
      appId: null,
      phase: 'LIVE',
      provisioned: true,
      when: '2m ago',
      at: '2026-07-29T10:00:00.000Z',
    } as const;
    const acts = {
      onNavigate: () => {},
      onCreate: async () => ({ ok: true }) as const,
      onAttach: async () => ({ ok: true }) as const,
      onDetach: async () => ({ ok: true }) as const,
      onDestroy: async () => ({ ok: true }) as const,
    };

    test('an unattached row offers Attach and an App to attach it to', () => {
      const markup = renderToStaticMarkup(
        <DatastoreLedger
          datastores={[store]}
          vessels={[]}
          apps={[
            {
              id: 'app-beacon',
              name: 'beacon',
              phase: 'LIVE',
              target: 'Metal',
              vessel: 'driftwood',
              url: 'beacon.apps.example',
              urlLive: true,
              kind: 'service',
              source: 'vcs.example/example/beacon',
              artifact: 'image · a1b2c3d4e5f6',
              when: '2m ago',
              at: '2026-07-29T10:00:00.000Z',
            },
          ]}
          {...acts}
        />,
      );
      expect(markup).toContain('Attach');
      expect(markup).toContain('beacon');
      expect(markup).not.toContain('>Detach<');
    });

    test('no App exists, so no picker is drawn', () => {
      const markup = renderToStaticMarkup(
        <DatastoreLedger
          datastores={[store]}
          vessels={[]}
          apps={[]}
          {...acts}
        />,
      );
      expect(markup).not.toContain('attach-app');
    });
  });

  describe('the timeline', () => {
    const view = WORKSPACE_SCENARIOS.service;
    const markup = workspace(view);

    test('is a sequence, joined by a rule its markers sit on', () => {
      expect(markup).toContain('Recent checkpoints');
      expect(markup).toContain('<ol');
    });

    test('says which stage every checkpoint belongs to', () => {
      const text = words(markup);
      for (const entry of view.activity) {
        expect(text).toContain(entry.kind);
        expect(text).toContain(entry.title);
      }
    });
  });
});

describe('the App workspace states what the release did', () => {
  const service = WORKSPACE_SCENARIOS.service;

  test('the hero dates the release and names the commit it shipped', () => {
    const markup = workspace({
      ...service,
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      when: '8m ago',
      at: '2026-07-28T13:00:00.000Z',
    });

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
    expect(markup.indexOf('is live')).toBeLessThan(
      markup.indexOf('role="tablist"'),
    );
  });

  test('config is behind its own view, and off the Overview', () => {
    expect(workspace(service)).not.toContain('value is write-only');
  });

  test('the live tail follows, and says what it dropped', () => {
    // The workspace appends every socket page, so the pane caps its lines.
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
    // `follow` bounds the pane's height, which gives it a bottom to scroll to.
    expect(chatty).toContain('max-h-[420px]');
  });

  test('no button on this screen does nothing when it is pressed', () => {
    // With no handlers wired, `SectionHeader` renders neither verb.
    const markup = workspace(service);

    expect(markup).not.toContain('Add Component');
    expect(markup).not.toContain('Attach Datastore');
  });
});

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
    expect(targets()).toContain('Edit connection');
  });

  test('a Target whose row and manifest entry disagree says so, in paths', () => {
    const markup = words(targets());
    expect(markup).toContain(
      'connection.chartValues.platform.gateway.name, connection.chartValues.platform.gateway.namespace',
    );
    // The row wins: a restart keeps the correction, and saving the manifest in
    // Settings replaces it.
    expect(markup).toContain('a restart leaves it alone');
    // Paths only, never values, as `diffManifestPaths` returns them.
    expect(markup).not.toContain('spindrift-apps');
  });

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
    const markup = words(card('target-primary'));
    expect(markup).not.toContain('Edit connection');
    expect(markup).not.toContain('Disconnect');
    expect(markup).toContain('where this control plane runs');
    expect(markup).toContain('cannot be disconnected');
  });

  test('an ordinary Target keeps both acts', () => {
    const markup = words(card('target-secondary'));
    expect(markup).toContain('Edit connection');
    expect(markup).toContain('Disconnect');
    expect(markup).not.toContain('cannot be disconnected');
  });

  test('the boundaries carry a checklist of their own, and say which they are', () => {
    const markup = words(targets());
    expect(markup).toContain('Boundaries this installation is built on');
    // Asked only of the home vessel, never of a Target or an app vessel.
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
    // A boundary is healthy only when every catalogued row is met.
    expect(markup).toContain('unhealthy');
  });

  test('an unmet row carries the change that clears it, and where it goes', () => {
    const markup = words(targets());
    expect(markup).toContain('Remediation');
    expect(markup).toContain('google_storage_bucket');
    expect(markup).toContain('terraform/projects/cloud/storage.tf');
    expect(markup).toContain('Copy');
    expect(markup).toContain('Open a pull request');
    expect(markup).toContain('Spindrift changes nothing here');
  });

  test('a row with no generated change says so rather than showing an empty box', () => {
    const markup = words(targets());
    expect(markup).toContain('No generated remediation');
    expect(markup).toContain('cannot be changed afterwards');
    // A row cleared outside Terraform names the tree that owns it.
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
    // With no root there is nowhere to open a pull request, but the stanza can
    // still be copied.
    expect(markup).not.toContain('Open a pull request');
    expect(markup).toContain('google_storage_bucket');
  });

  test('a boundary nobody has been past says so rather than reading as passed', () => {
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

    // The App chart renders the route and the filter from values written at
    // deploy time.
    expect(markup).toContain(
      'takes effect on the next Deploy rather than on the one that is serving',
    );
    for (const cell of ['none', 'private', 'public', 'proxy']) {
      expect(markup).toContain(cell);
    }
  });
});

describe('moving a placed Component from the App workspace (§3, §10)', () => {
  const view = WORKSPACE_SCENARIOS.service;
  const component = {
    ...view.components[0]!,
    // Mid-move: placed on one Target and still serving on both, the state
    // `placeComponent` leaves behind.
    target: 'primary/kubernetes',
    serving: [
      { targetId: 'target-primary', label: 'primary/kubernetes' },
      { targetId: 'target-cloudrun', label: 'vessel-a/cloudrun' },
    ],
  };
  const placed = { ...view, components: [component] };
  const move = async () => ({ ok: true as const, carried: [] });
  const unplace = async () => ({ ok: true as const, destroyed: true });

  test('the verb is on the row only where both acts and a list of Targets are', () => {
    // Move without Unplace could strand a workload it cannot tear down.
    expect(workspace(placed)).not.toContain('Move');
    expect(
      renderToStaticMarkup(
        <Workspace
          view={placed}
          tab="config"
          onMoveComponent={move}
          onUnplaceComponent={unplace}
        />,
      ),
    ).not.toContain('Move');

    expect(
      renderToStaticMarkup(
        <Workspace
          view={placed}
          tab="config"
          onMoveComponent={move}
          onUnplaceComponent={unplace}
          targets={TARGET_LIST}
        />,
      ),
    ).toContain('Move');
  });

  test('a Component nothing has placed is not offered a move', () => {
    // A first placement belongs to `deployApp`, which writes it while null.
    expect(
      renderToStaticMarkup(
        <Workspace
          view={view}
          tab="config"
          onMoveComponent={move}
          onUnplaceComponent={unplace}
          targets={TARGET_LIST}
        />,
      ),
    ).not.toContain('Move');
  });

  test('every pair that still serves gets its own Unplace', () => {
    const markup = renderToStaticMarkup(
      <PlacementEditor
        component={component}
        targets={TARGET_LIST}
        onMoveComponent={move}
        onUnplaceComponent={unplace}
        onDone={() => undefined}
      />,
    );

    // One control per pair, because `unplaceComponent` takes a pair.
    expect(markup).toContain('primary/kubernetes');
    expect(markup).toContain('vessel-a/cloudrun');
    expect(markup.match(/Unplace/g)?.length).toBe(2);
  });

  test('the Targets offered are the ones that take this kind', () => {
    const website = { ...component, kind: 'website' as const };
    const jobOnly = [
      ...TARGET_LIST.filter((target) => target.adapter !== 'static'),
      {
        ...TARGET_LIST[0]!,
        id: 'target-files',
        vessel: 'edge',
        adapter: 'static' as const,
        kinds: ['website' as const],
      },
    ];

    const asWebsite = renderToStaticMarkup(
      <PlacementEditor
        component={website}
        targets={jobOnly}
        onMoveComponent={move}
        onUnplaceComponent={unplace}
        onDone={() => undefined}
      />,
    );
    expect(asWebsite).toContain('edge/static');

    const asService = renderToStaticMarkup(
      <PlacementEditor
        component={component}
        targets={jobOnly}
        onMoveComponent={move}
        onUnplaceComponent={unplace}
        onDone={() => undefined}
      />,
    );
    expect(asService).not.toContain('edge/static');
  });

  test('the demanded keys are a form, not a dead end', () => {
    const sentence =
      'API_KEY, TOKEN are configured through a store vessel-a/cloudrun cannot reach';
    const markup = renderToStaticMarkup(
      <SupplyDemand
        message={sentence}
        demanded={['API_KEY', 'TOKEN']}
        onSupply={() => undefined}
      />,
    );

    expect(markup).toContain(sentence);
    expect(markup).toContain('name="supply-API_KEY"');
    expect(markup).toContain('name="supply-TOKEN"');
    // Supplying the keys and moving is one post.
    expect(markup).toContain('Supply and move');
    expect(markup).not.toContain('Save');
  });
});

describe('adding a Component from the App it belongs to (§2)', () => {
  const view = WORKSPACE_SCENARIOS.service;
  const form = (kind?: 'service' | 'website' | 'job') =>
    words(
      renderToStaticMarkup(
        <NewComponentForm
          onCreateComponent={async () => ({ ok: true })}
          onDone={() => undefined}
          {...(kind === undefined ? {} : { kind })}
        />,
      ),
    );

  test('the verb is on the section only where an act is wired', () => {
    expect(
      renderToStaticMarkup(<Workspace view={view} tab="config" />),
    ).not.toContain('Add Component');

    const markup = renderToStaticMarkup(
      <Workspace
        view={view}
        tab="config"
        onCreateComponent={async () => ({ ok: true })}
      />,
    );
    expect(markup).toContain('Add Component');
  });

  test('a schedule is asked for on a job and on nothing else', () => {
    // The command's input is a `.strict()` union, so a schedule on any other
    // kind fails validation.
    expect(form()).not.toContain('Schedule');
    expect(form('website')).not.toContain('Schedule');

    const job = form('job');
    expect(job).toContain('Schedule');
    expect(job).toContain('Five cron fields');
    expect(job).toContain('placed suspended');
  });

  test('every kind is offered, and none of them asks for reach or expose', () => {
    const markup = form();
    for (const kind of ['service', 'website', 'job']) {
      expect(markup).toContain(kind);
    }
    // Reach and auth take the command's defaults; `ReachEditor` changes them.
    expect(markup).not.toContain(REACH_NOTE.public);
    expect(markup).not.toContain(AUTH_NOTE.proxy);
  });
});

describe('editing config from the workspace (§10)', () => {
  const view = WORKSPACE_SCENARIOS.service;
  const config = (v: WorkspaceView) =>
    renderToStaticMarkup(<Workspace view={v} tab="config" />);

  test('every configured key is shown, and nothing about its value is', () => {
    const markup = config(view);
    for (const key of view.configKeys) {
      expect(markup).toContain(key);
    }
    expect(markup).toContain('value is write-only');
    expect(markup).toContain(
      'redeploys what is running under a new configVersion',
    );
  });

  test('the affordance is on the section only where an act is wired', () => {
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
    // Called directly, because `renderToStaticMarkup` cannot click.
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

    // A removal names only the key; values are write-only.
    expect(calls).toEqual([{ entries: [], removals: ['DATABASE_URL'] }]);
  });
});

describe('a commit shows its headline beside the sha', () => {
  test('the App hero puts the headline beside the seven characters', () => {
    const markup = workspace({
      ...WORKSPACE_SCENARIOS.service,
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      commitMessage: 'feat(web): stop the header wrapping',
      when: '8m ago',
      at: '2026-07-28T13:00:00.000Z',
    });
    expect(markup).toContain('a1b2c3d');
    expect(markup).toContain('feat(web): stop the header wrapping');
  });

  test('the deploy screen names the message and the author under the commit', () => {
    const source = DEPLOY_SCENARIOS.live.source;
    if (source.kind !== 'repo') throw new Error('the live scenario is a repo');
    const markup = deploy({
      ...DEPLOY_SCENARIOS.live,
      source: {
        ...source,
        commitMessage: 'feat(web): stop the header wrapping',
        commitAuthor: 'octocat',
        commitAuthoredAt: '2026-07-28T12:00:00.000Z',
      },
    });
    expect(markup).toContain('feat(web): stop the header wrapping');
    expect(markup).toContain('octocat');
    expect(markup).toContain('2026-07-28T12:00:00.000Z');
  });

  test('a Build that kept no headline still shows its sha', () => {
    const source = DEPLOY_SCENARIOS.live.source;
    if (source.kind !== 'repo') throw new Error('the live scenario is a repo');
    const markup = deploy({
      ...DEPLOY_SCENARIOS.live,
      source: { ...source, commitMessage: null, commitAuthor: null },
    });
    expect(markup).toContain(source.commit);
    expect(markup).not.toContain('Author');
  });

  test('the Overview names the release it is serving, not only its sha', () => {
    const serving: DeployLedgerItem = {
      id: 993,
      appId: 'app-morrow',
      app: 'morrow',
      buildId: 1837,
      componentId: 'component-web',
      component: 'web',
      targetId: 'target-folly',
      target: 'Folly',
      phase: 'LIVE',
      commit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      commitMessage: 'feat(web): stop the header wrapping',
      configVersion: '9e2bc1',
      when: '8m ago',
      at: '2026-07-28T13:00:00.000Z',
      current: true,
      rollbackable: false,
    };
    const markup = renderToStaticMarkup(
      <Overview
        apps={[]}
        builds={[]}
        deploys={[serving]}
        targets={[]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('a1b2c3d');
    expect(markup).toContain('feat(web): stop the header wrapping');
  });
});
