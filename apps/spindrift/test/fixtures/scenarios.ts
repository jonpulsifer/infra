/**
 * Standalone scenarios for looking at every settled screen state without a
 * database. Product routes use command-owned state. Nothing here is imported
 * by anything outside `src/web/`.
 *
 * Every name in it is invented. §20 puts every value that names an installation
 * in the manifest, and a fixture is not an exemption — a demo hostname that
 * happens to be real is the literal the extraction grep exists to catch. The
 * apex below is a reserved documentation domain for that reason.
 *
 * The six deploy scenarios are the prototype's, kept whole. They are not a
 * sampler: each one is a state §6 says the system can be in, and together they
 * are the set the deploy screen was designed against — including the three
 * where a previous release is still serving, which is the case §18 says changed
 * the feel of failure more than anything else.
 */
import type {
  ComponentKind,
  Exposure,
} from '../../src/domain/desired-state.ts';
import type {
  AppListItem,
  ChecklistItem,
  DeployView,
  LinkedRepoView,
  LogLine,
  RepositoryOptionView,
  TargetListItem,
  TargetOptionView,
  WorkspaceView,
} from '../../src/web/model.ts';
import type { Draft } from '../../src/web/views/apps/new/draft.ts';

/** A reserved documentation apex — never a zone anybody serves from. */
const APEX = 'apps.example';

const BUILD_STEPS_OK: readonly ChecklistItem[] = [
  { name: 'checkout', status: 'done', detail: '1.2s' },
  { name: 'detect frontend', status: 'done', detail: '0.4s' },
  { name: 'plan runtime', status: 'done', detail: '3.1s' },
  { name: 'install dependencies', status: 'done', detail: '11.8s' },
  { name: 'run build', status: 'done', detail: '24.6s' },
  { name: 'export image', status: 'done', detail: '6.0s' },
  { name: 'push registry', status: 'done', detail: '8.4s' },
];

const LOG_OK: readonly LogLine[] = [
  { text: '#8 [builder 4/6] RUN install', tone: 'muted' },
  { text: '#8 1284 packages installed [11.80s]' },
  { text: '#9 [builder 5/6] RUN build', tone: 'muted' },
  { text: '#9 Creating an optimized production build ...' },
  { text: '#9 Route (app)                    Size   First Load' },
  { text: '#9 ┌ ○ /                        4.71 kB     102 kB' },
  { text: '#9 └ ○ /about                   1.02 kB      98 kB' },
  { text: '#9 DONE  compiled successfully in 24.6s' },
  { text: '#11 exporting to image', tone: 'muted' },
  { text: '#11 naming to registry.example/almanac@sha256:9f2c1a…' },
];

const RESOURCES_OK: readonly ChecklistItem[] = [
  { name: 'Deployment/web', status: 'done', detail: '2/2 ready' },
  { name: 'Service/web', status: 'done', detail: 'ClusterIP allocated' },
  { name: 'HTTPRoute/web', status: 'done', detail: 'accepted by gateway' },
  { name: 'DNSEndpoint/web', status: 'done', detail: 'published' },
];

/** Every resource healthy except the workload itself — the deploy-failure shape. */
function resourcesFailingWith(detail: string): readonly ChecklistItem[] {
  return [
    { name: 'Deployment/web', status: 'failed', detail },
    ...RESOURCES_OK.slice(1),
  ];
}

const BASE = {
  id: 42,
  buildId: 41,
  componentId: '00000000-0000-4000-8000-000000000041',
  targetId: '00000000-0000-4000-8000-000000000042',
  appId: '00000000-0000-4000-8000-000000000040',
  app: 'almanac',
  component: 'web',
  target: 'Metal',
  commit: 'dd9b103',
  url: `almanac.${APEX}`,
  deployLog: [
    { text: 'controller accepted the deploy', tone: 'muted' },
    { text: 'platform reconciliation reached a terminal state' },
  ],
} as const;

const BUILT = {
  status: 'done',
  duration: '55.5s',
  fidelity: 'LIVE_TEXT',
  steps: BUILD_STEPS_OK,
  log: LOG_OK,
  runner: 'hosted runner',
} as const;

/**
 * The scenarios, keyed by the word that names the situation rather than by an
 * index — a demo switcher that says "3" teaches nobody what state 3 is.
 */
export const DEPLOY_SCENARIOS = {
  live: {
    ...BASE,
    phase: 'LIVE',
    phaseWord: 'Live',
    headline: 'Deployed 40 seconds ago',
    urlLive: true,
    previousReleaseServing: false,
    diagnosis: null,
    resources: RESOURCES_OK,
    build: BUILT,
  },

  building: {
    ...BASE,
    phase: 'WAITING',
    phaseWord: 'Building',
    headline: 'Building on a hosted runner',
    urlLive: false,
    previousReleaseServing: true,
    diagnosis: null,
    resources: RESOURCES_OK.map((resource) => ({
      name: resource.name,
      status: 'waiting' as const,
    })),
    build: {
      status: 'running',
      duration: '31s',
      // The case §18 makes mandatory to state: status is live, text is not.
      fidelity: 'LIVE_STATUS',
      steps: [
        ...BUILD_STEPS_OK.slice(0, 4),
        { name: 'run build', status: 'running', detail: '14s' },
        { name: 'export image', status: 'waiting' },
        { name: 'push registry', status: 'waiting' },
      ],
      log: null,
      runner: 'hosted runner',
    },
  },

  buildFailed: {
    ...BASE,
    phase: 'FAILED',
    phaseWord: 'Build failed',
    headline: 'Build failed after 19 seconds',
    urlLive: false,
    previousReleaseServing: true,
    diagnosis: {
      reason: 'BUILD_FAILED',
      blame: 'developer',
      detail:
        "Type error in app/page.tsx line 14 — 'sesion' should be 'session'.",
      evidence: [
        'ERROR: failed to solve: process "/bin/sh -c run build"',
        '  did not complete successfully: exit code: 1',
        'frontend: zero-config builder',
      ].join('\n'),
    },
    resources: [],
    build: {
      status: 'failed',
      duration: '19.4s',
      fidelity: 'LIVE_TEXT',
      steps: [
        ...BUILD_STEPS_OK.slice(0, 4),
        { name: 'run build', status: 'failed', detail: '2.9s' },
        { name: 'export image', status: 'waiting' },
        { name: 'push registry', status: 'waiting' },
      ],
      log: [
        { text: '#9 [builder 5/6] RUN build', tone: 'muted' },
        { text: '#9 Creating an optimized production build ...' },
        { text: '#9 Failed to compile.', tone: 'error' },
        { text: '#9 ./app/page.tsx:14:22', tone: 'error' },
        {
          text: "#9 Type error: Property 'sesion' does not exist on type",
          tone: 'error',
        },
        { text: "#9 'Viewer'. Did you mean 'session'?", tone: 'error' },
        { text: '#9 > 14 |   return <Hello name={viewer.sesion.name} />;' },
        { text: '#9 ERROR: exited with code 1', tone: 'error' },
      ],
      runner: 'hosted runner',
    },
  },

  /**
   * The reason `blame` earns a chip: the build is green, so every instinct
   * says "look at my app", and the chip is what says otherwise.
   */
  imageUnpullable: {
    ...BASE,
    phase: 'FAILED',
    phaseWord: 'Deploy failed',
    headline: "Deploy failed — the cluster can't pull the image",
    urlLive: false,
    previousReleaseServing: true,
    diagnosis: {
      reason: 'ARTIFACT_UNAVAILABLE',
      blame: 'platform',
      detail:
        "Metal can't authenticate to the registry. The image built fine — the cluster's pull credential is rejected.",
      evidence: [
        'Events (Pod/web-…):',
        '  Failed  kubelet  Failed to pull image',
        '    failed to authorize: 401 Unauthorized',
        '  BackOff kubelet  Back-off pulling image',
      ].join('\n'),
    },
    resources: resourcesFailingWith('0/2 ready — ImagePullBackOff'),
    build: BUILT,
  },

  crashLooping: {
    ...BASE,
    phase: 'FAILED',
    phaseWord: 'Deploy failed',
    headline: 'Deploy failed — the container keeps exiting',
    urlLive: false,
    previousReleaseServing: true,
    diagnosis: {
      reason: 'STARTUP_FAILED',
      blame: 'developer',
      detail:
        'The container exits immediately on start: DATABASE_URL is not set.',
      evidence: [
        'Last log line before exit (Pod/web-…):',
        '  Error: DATABASE_URL is required',
        '  exit code 1',
        '',
        'Restart count: 5   Last state: Terminated',
      ].join('\n'),
    },
    resources: resourcesFailingWith('0/2 ready — CrashLoopBackOff ×5'),
    build: BUILT,
  },

  neverReady: {
    ...BASE,
    phase: 'FAILED',
    phaseWord: 'Deploy failed',
    headline: 'Deploy failed — never became healthy',
    urlLive: false,
    previousReleaseServing: true,
    diagnosis: {
      reason: 'UNHEALTHY',
      blame: 'developer',
      detail:
        'The container starts but /healthz never returns 200. Gave up after 10 minutes.',
      evidence: [
        'Events (Pod/web-…):',
        '  Warning  Unhealthy  kubelet',
        '    Readiness probe failed: statuscode 503  (×48)',
        '',
        'Probe: GET :3000/healthz  period=10s  timeout=1s',
      ].join('\n'),
    },
    resources: resourcesFailingWith('0/2 ready — readiness probe failing'),
    build: BUILT,
  },
} as const satisfies Record<string, DeployView>;

export type DeployScenarioName = keyof typeof DEPLOY_SCENARIOS;

export const DEPLOY_SCENARIO_NAMES = Object.keys(
  DEPLOY_SCENARIOS,
) as DeployScenarioName[];

/**
 * The three workspace cases the prototype settled against, one per kind.
 *
 * `almanac` is the case that carries §17's honest empty state: a website on a
 * static Target has no process, so `runtime` is `null` rather than an empty
 * array — the difference between "there is nothing to show" and "there is
 * nothing here to show it from".
 */
export const WORKSPACE_SCENARIOS = {
  service: {
    app: 'beacon',
    target: 'Metal',
    vessel: 'driftwood',
    prerequisitesMet: true,
    phase: 'LIVE',
    url: `beacon.${APEX}`,
    urlLive: true,
    release: 'Deploy 42',
    components: [
      {
        name: 'web',
        kind: 'service',
        phase: 'LIVE',
        artifact: 'image · sha256:93a7…fe21',
        exposure: 'private',
      },
    ],
    datastores: [
      {
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        attachedTo: 'web',
        target: 'Metal',
      },
      {
        name: 'cache',
        engine: 'redis',
        provenance: 'managed',
        attachedTo: null,
        target: 'Metal',
      },
    ],
    activity: [
      {
        title: 'Deploy 42 live',
        detail: 'Artifact reconciled on Metal; all resources healthy.',
        when: '8m ago',
        status: 'ok',
      },
      {
        title: 'Build passed',
        detail: 'main · 7f3d2c1 · hosted runner',
        when: '9m ago',
        status: 'ok',
      },
      {
        title: 'Deploy 40 failed',
        detail: 'STARTUP_FAILED · developer · DATABASE_URL missing',
        when: '1d ago',
        status: 'failed',
      },
    ],
    runtime: {
      kind: 'stream',
      componentId: '00000000-0000-4000-8000-000000000041',
      targetId: '00000000-0000-4000-8000-000000000042',
      // The Deploy marker is in the stream rather than filtering it — §17's
      // "Deploys are markers on the timeline, never a filter".
      lines: [
        { text: '── Deploy 42 · 8m ago ──', tone: 'muted' },
        { text: 'web-6d9f  listening on :3000' },
        { text: 'web-6d9f  GET /healthz 200  4ms' },
        { text: 'web-6d9f  GET / 200  31ms' },
      ],
      reach: '7 days',
    },
  },

  website: {
    app: 'almanac',
    target: 'Static hosting',
    vessel: 'driftwood',
    prerequisitesMet: true,
    phase: 'LIVE',
    url: `almanac.${APEX}`,
    urlLive: true,
    release: 'Deploy 17',
    components: [
      {
        name: 'web',
        kind: 'website',
        phase: 'LIVE',
        artifact: 'files · sha256:b119…02a8',
        exposure: 'public',
      },
    ],
    // §11: a website cannot attach a Datastore.
    datastores: [],
    activity: [
      {
        title: 'Deploy 17 live',
        detail: 'Files released to static hosting.',
        when: '2h ago',
        status: 'ok',
      },
      {
        title: 'Build passed',
        detail: 'main · 91dc4ab · hosted runner',
        when: '2h ago',
        status: 'ok',
      },
    ],
    runtime: {
      kind: 'none',
      because:
        'Static files are served by the Target, so there is no process output to stream. Build and deploy events remain in Activity.',
    },
  },

  job: {
    app: 'ledger',
    target: 'Cloud Run',
    vessel: 'driftwood',
    prerequisitesMet: true,
    phase: 'LIVE',
    url: `ledger.${APEX}`,
    urlLive: false,
    release: 'Execution 118',
    components: [
      {
        name: 'nightly',
        kind: 'job',
        phase: 'LIVE',
        artifact: 'image · sha256:7cc2…198f',
        exposure: 'internal',
      },
    ],
    datastores: [
      {
        name: 'archive',
        engine: 'postgres',
        provenance: 'external',
        attachedTo: 'nightly',
        target: 'Cloud Run',
      },
    ],
    activity: [
      {
        title: 'Execution 118 passed',
        detail: '02:14 · 1,284 objects copied',
        when: '8m ago',
        status: 'ok',
      },
      {
        title: 'Execution 116 failed',
        detail: 'exit 1 · bucket unavailable',
        when: '1d ago',
        status: 'failed',
      },
    ],
    // §17: a job is a list of executions, not a stream. The depth is achieved
    // by configuring the platform's own limit, never by storing logs — hence a
    // count here rather than a duration.
    runtime: {
      kind: 'executions',
      retained: 10,
      executions: [
        {
          name: 'Execution 118',
          outcome: 'passed',
          detail: '1,284 objects copied in 2m14s',
          when: '8m ago',
        },
        {
          name: 'Execution 117',
          outcome: 'passed',
          detail: '1,190 objects copied in 2m02s',
          when: '1d ago',
        },
        {
          name: 'Execution 116',
          outcome: 'failed',
          detail: 'exit 1 · bucket unavailable',
          when: '2d ago',
        },
      ],
    },
  },
} as const satisfies Record<string, WorkspaceView>;

export type WorkspaceScenarioName = keyof typeof WORKSPACE_SCENARIOS;

export const WORKSPACE_SCENARIO_NAMES = Object.keys(
  WORKSPACE_SCENARIOS,
) as WorkspaceScenarioName[];

/**
 * The Targets the Place step lists — two candidates and two not.
 *
 * The excluded pair is the point of the fixture. §3's grammar is that a
 * non-candidate is listed, disabled, and annotated, and a demo where everything
 * fits never shows the half of the design that does the work.
 */
export const TARGET_OPTIONS: readonly TargetOptionView[] = [
  {
    targetId: 'metal',
    name: 'Metal',
    adapter: 'kubernetes',
    rank: 1,
    candidate: true,
    artifactType: 'image',
    canonical: `almanac.metal.${APEX}`,
    reasons: [],
    detail: [],
  },
  {
    targetId: 'cloud',
    name: 'Cloud Run',
    adapter: 'cloudrun',
    rank: 2,
    candidate: true,
    artifactType: 'image',
    canonical: `almanac.run.${APEX}`,
    reasons: [],
    detail: [],
  },
  {
    targetId: 'static',
    name: 'Static hosting',
    adapter: 'static',
    rank: 3,
    candidate: false,
    artifactType: null,
    canonical: `almanac.static.${APEX}`,
    reasons: ['KIND_UNSUPPORTED'],
    detail: ['a static Target takes a website and nothing else'],
  },
  {
    targetId: 'remote',
    name: 'Remote cluster',
    adapter: 'kubernetes',
    rank: 4,
    candidate: false,
    artifactType: null,
    canonical: `almanac.remote.${APEX}`,
    reasons: ['UNHEALTHY', 'EXPOSURE_UNSUPPORTED'],
    detail: [
      'the prerequisite checklist has an unmet item: no writable secret store',
      'publicExposure is not asserted for this Target',
    ],
  },
];

/** The draft a developer who pressed "Link repo" lands on. */
export const INITIAL_DRAFT: Draft = {
  entry: 'repo',
  source: {
    kind: 'repo',
    repo: 'example/almanac',
    url: 'https://vcs.example/example/almanac',
    subpath: 'apps/web',
  },
  appName: 'almanac',
  componentName: 'web',
  detection: {
    kind: 'service' satisfies ComponentKind,
    reason: 'the zero-config builder found a start command',
    available: ['service', 'job'],
    unavailable: {
      website: 'the framework is not configured to emit static files',
    },
  },
  kind: 'service',
  vessel: {
    name: 'driftwood',
    ready: true,
    note: 'the default shared vessel',
  },
  targetId: 'metal',
  exposure: 'private' satisfies Exposure,
  config: [
    { name: 'LOG_LEVEL', supplied: true },
    { name: 'DATABASE_URL', supplied: false },
  ],
  step: 0,
};

/** Available repositories from the GitHub App installation. */
export const REPOSITORY_OPTIONS: readonly RepositoryOptionView[] = [
  {
    repositoryId: 100001,
    fullName: 'example-org/infra',
    defaultBranch: 'main',
    connected: true,
  },
  {
    repositoryId: 100002,
    fullName: 'example-org/hub',
    defaultBranch: 'main',
    connected: true,
  },
  {
    repositoryId: 100003,
    fullName: 'example-org/site',
    defaultBranch: 'main',
    connected: false,
  },
  {
    repositoryId: 100004,
    fullName: 'example-org/api',
    defaultBranch: 'main',
    connected: true,
  },
  {
    repositoryId: 100005,
    fullName: 'example-org/weather-card',
    defaultBranch: 'main',
    connected: false,
  },
];

/** Linked repositories for the management view. */
export const LINKED_REPOS: readonly LinkedRepoView[] = [
  {
    repositoryId: 100001,
    fullName: 'example-org/infra',
    defaultBranch: 'main',
    health: 'connected',
    error: null,
    lastReconciledSha: 'a1b2c3d',
    appSubpaths: ['apps/hub', 'apps/api', 'apps/wiki'],
  },
  {
    repositoryId: 100002,
    fullName: 'example-org/hub',
    defaultBranch: 'main',
    health: 'connected',
    error: null,
    lastReconciledSha: 'e4f5g6h',
    appSubpaths: ['.'],
  },
  {
    repositoryId: 100004,
    fullName: 'example-org/api',
    defaultBranch: 'main',
    health: 'connection_lost',
    error:
      'Installation suspended — the GitHub App installation was suspended by the account owner.',
    lastReconciledSha: 'i7j8k9l',
    appSubpaths: ['.'],
  },
];

/** App list demo data. */
export const APP_LIST: readonly AppListItem[] = [
  {
    name: 'hub',
    phase: 'LIVE',
    target: 'Primary',
    vessel: 'vessel-a',
    url: 'hub.apps.example',
    urlLive: true,
    kind: 'service',
    source: 'example-org/infra',
    release: 'Deploy #14 · a1b2c3d',
  },
  {
    name: 'api',
    phase: 'LIVE',
    target: 'Primary',
    vessel: 'vessel-a',
    url: 'api.apps.example',
    urlLive: true,
    kind: 'service',
    source: 'example-org/api',
    release: 'Deploy #8 · m3n4o5p',
  },
  {
    name: 'wiki',
    phase: 'FAILED',
    target: 'Cloud Run · vessel-a',
    vessel: 'vessel-a',
    url: 'wiki.apps.example',
    urlLive: true,
    kind: 'website',
    source: 'example-org/infra',
    release: 'Deploy #3 · q6r7s8t',
  },
  {
    name: 'weather-card',
    phase: 'APPLYING',
    target: 'Firebase · vessel-a',
    vessel: 'vessel-a',
    url: 'weather-card.web.app',
    urlLive: false,
    kind: 'website',
    source: 'archive',
    release: 'Deploy #1 · sha256:d82a…',
  },
];

/** Target list demo data. */
export const TARGET_LIST: readonly TargetListItem[] = [
  {
    name: 'Primary',
    adapter: 'kubernetes',
    rank: 1,
    health: 'healthy',
    kinds: ['service', 'website', 'job'],
    canonical: '*.primary.apps.example',
  },
  {
    name: 'Cloud Run · vessel-a',
    adapter: 'cloudrun',
    rank: 2,
    health: 'healthy',
    kinds: ['service', 'website', 'job'],
    canonical: '*.northamerica-northeast1.run.app',
  },
  {
    name: 'Firebase · vessel-a',
    adapter: 'static',
    rank: 3,
    health: 'healthy',
    kinds: ['website'],
    canonical: '*.web.app',
  },
  {
    name: 'Secondary',
    adapter: 'kubernetes',
    rank: 4,
    health: 'unhealthy',
    kinds: ['service', 'website', 'job'],
    canonical: '*.secondary.apps.example',
  },
];
