/**
 * The cloud build route: submits the shared BuildKit program to the cloud build
 * service, reads its log while it runs, and attests the image it pushed.
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import {
  buildKitProgramFor,
  buildSecretEnvOf,
  dockerConfigFor,
  quote,
  REGISTRY_AUTH_VAR,
} from './buildkit.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildHandle,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import type { BuildRouteDescriptor } from './descriptor.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request, never a stored credential. */
export type TokenProvider = () => string | Promise<string>;

interface CloudBuild {
  readonly id: string;
  readonly status?: string;
  readonly statusDetail?: string;
}

interface LogEntry {
  /** The log service's own entry id, used to skip entries already emitted. */
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly timestamp?: string;
}

/**
 * How far before the newest entry read each search reaches back. Entries are
 * ingested out of order, and {@link keyOf} drops what was already emitted.
 */
const LOG_LATENESS_MS = 60_000;

/** Pages per search. The next poll re-reads the window, so stopping early adds only latency. */
const MAX_LOG_PAGES = 50;

/**
 * How long a finished build's log is read for its report. Ingestion lags the
 * writer, and the report is written in the build's last seconds.
 */
const LOG_TAIL_TIMEOUT_MS = 60_000;

interface LogTail {
  /** Entries already emitted, by {@link keyOf}. */
  readonly seen: Set<string>;
  /** The newest entry timestamp seen, which anchors the next search's window. */
  newest: Date | null;
  /** Everything emitted, for {@link parseBuildReport}. */
  log: string;
}

export interface CloudBuildRouteOptions extends PollingOptions {
  readonly name: string;
  /** The build service's API root, without a trailing slash. */
  readonly endpoint: string;
  /** The log service's API root, without a trailing slash. */
  readonly logsEndpoint: string;
  readonly project: string;
  readonly region: string;
  readonly image: string;
  readonly zeroConfigFrontend: string;
  /** The installation's KMS signing key, used here only for the attestation. */
  readonly signer: string;
  /**
   * `projects/<project>/attestors/<name>`, or empty for no attestation. A cloud
   * runtime's admission checks this attestation, not the registry signature.
   */
  readonly attestor: string;
  readonly token: TokenProvider;
  readonly fetch?: Fetcher;
}

/** `EXPIRED` is a build that waited in the queue past its deadline and never ran. */
const TERMINAL = new Set([
  'SUCCESS',
  'FAILURE',
  'INTERNAL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXPIRED',
]);

export class CloudBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'LIVE_TEXT';
  readonly provenanceBuilderId =
    'https://cloudbuild.googleapis.com/GoogleHostedWorker';
  /** L3: a managed, ephemeral worker the repository's maintainers cannot reach. */
  readonly buildLevel: BuildLevel = 3;
  /** Secrets ride the build step's environment, never the program text. */
  readonly carriesHeldSecret = true;
  /** The step's metadata token covers one vendor's registries and nothing else. */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [
    'artifactRegistry',
  ];

  constructor(private readonly options: CloudBuildRouteOptions) {
    this.name = options.name;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;

    if (source.origin.type === 'repo') {
      yield {
        type: 'log',
        at: now(),
        line: 'building from the staged bundle, not from the repository',
      };
    }

    const program = buildKitProgramFor(
      source,
      spec,
      this.options.zeroConfigFrontend,
    );

    let build: CloudBuild;
    try {
      build = await this.submit(program, spec, dispatchId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'log', at: now(), line: `submit failed: ${detail}` };
      return buildFailed(
        logs,
        'TARGET_UNREACHABLE',
        `could not submit a build to ${this.options.project}: ${detail}`,
      );
    }

    yield { type: 'log', at: now(), line: `build ${build.id} submitted` };

    const budget = deadlineFrom(this.options);
    const tail: LogTail = { seen: new Set(), newest: null, log: '' };
    let status = build.status ?? 'QUEUED';
    let statusDetail = build.statusDetail;

    for (;;) {
      yield* this.readLog(build.id, tail, now);

      const current = await this.read(build.id);
      if (current !== null) {
        status = current.status ?? status;
        statusDetail = current.statusDetail ?? statusDetail;
      }
      if (TERMINAL.has(status)) break;

      if (budget.expired()) {
        // Best-effort: the Build fails either way, and the service's own timeout
        // reclaims a worker the cancel missed.
        yield {
          type: 'log',
          at: now(),
          line: `build ${build.id} did not finish within the build budget; cancelling it`,
        };
        await this.cancelBuild(build.id).catch(() => {});
        return buildFailed(
          logs,
          'TIMEOUT',
          `build ${build.id} did not finish within the build budget`,
          { buildId: build.id, status },
        );
      }
      await budget.tick();
    }

    // Read again after the build concludes: its last seconds, which carry the
    // report, were written after the loop's final read.
    const drain = deadlineFrom({
      ...this.options,
      timeoutMs: LOG_TAIL_TIMEOUT_MS,
    });
    for (;;) {
      yield* this.readLog(build.id, tail, now);
      // A red build prints no report, so one read is enough.
      if (status !== 'SUCCESS') break;
      if (parseBuildReport(tail.log) !== null) break;
      if (drain.expired()) break;
      await drain.tick();
    }

    const log = tail.log;

    if (status !== 'SUCCESS') {
      // A build that timed out, expired or was cancelled blames nobody.
      return buildFailed(
        logs,
        status === 'TIMEOUT' || status === 'EXPIRED' || status === 'CANCELLED'
          ? 'TIMEOUT'
          : 'BUILD_FAILED',
        statusDetail ?? `build ${build.id} ended ${status}`,
        { buildId: build.id, status },
      );
    }

    // The build's `results` lists only images the service pushed itself, so the
    // report comes from the log.
    const report = parseBuildReport(log);
    if (report === null) {
      return buildFailed(
        logs,
        'INTERNAL',
        `build ${build.id} succeeded but reported no artifact`,
        { buildId: build.id },
      );
    }

    return buildSucceeded({
      source,
      spec,
      logs,
      level: this.buildLevel,
      report: {
        ...report,
        // The backend provenance core verifies before signing.
        statement: { build: build.id, project: this.options.project },
      },
    });
  }

  /**
   * Cancel every unfinished build under the dispatch id's tag. The service
   * assigns build ids, so the tag is how the route finds its build.
   */
  async cancel(handle: BuildHandle): Promise<void> {
    const filter = encodeURIComponent(`tags="${tagFor(handle.dispatchId)}"`);
    const listed = await this.json<{ builds?: CloudBuild[] }>(
      `${this.options.endpoint}/v1/${this.parent}/builds?filter=${filter}`,
      { method: 'GET' },
    );
    for (const build of listed?.builds ?? []) {
      if (TERMINAL.has(build.status ?? '')) continue;
      await this.cancelBuild(build.id);
    }
  }

  private get parent(): string {
    return `projects/${this.options.project}/locations/${this.options.region}`;
  }

  private cancelBuild(id: string): Promise<unknown> {
    return this.json(
      `${this.options.endpoint}/v1/${this.parent}/builds/${encodeURIComponent(id)}:cancel`,
      { method: 'POST', body: {} },
    );
  }

  private async submit(
    program: string,
    spec: BuildSpec,
    dispatchId?: string,
  ): Promise<CloudBuild> {
    const attest = attestStep(spec.destinations, this.options);
    const dockerConfig = dockerConfigFor(spec.registryAuth);
    // Secrets stay out of the program text. `literalDollars` because a secret's
    // value is text, never a substitution.
    const stepEnv = [
      ...(dockerConfig === null
        ? []
        : [`${REGISTRY_AUTH_VAR}=${dockerConfig}`]),
      ...Object.entries(buildSecretEnvOf(spec.buildSecrets)).map(
        ([name, value]) => `${name}=${value}`,
      ),
    ].map(literalDollars);
    const operation = await this.json<{
      metadata?: { build?: CloudBuild };
    }>(`${this.options.endpoint}/v1/${this.parent}/builds`, {
      method: 'POST',
      body: {
        steps: [
          {
            name: this.options.image,
            entrypoint: 'sh',
            args: [
              '-c',
              literalDollars(
                registryAuth(spec.destinations) +
                  program +
                  exportDigest(attest),
              ),
            ],
            ...(stepEnv.length === 0 ? {} : { env: stepEnv }),
          },
          ...(attest === null
            ? []
            : [{ ...attest, args: attest.args.map(literalDollars) }]),
        ],
        // The build's output goes to the log service, which `readLog` polls.
        options: { logging: 'CLOUD_LOGGING_ONLY' },
        // What `cancel` finds the build by, from the Build row alone.
        ...(dispatchId === undefined ? {} : { tags: [tagFor(dispatchId)] }),
      },
    });
    const build = operation?.metadata?.build;
    if (build === undefined) {
      throw new TypeError('the build service named no build');
    }
    return build;
  }

  private read(id: string): Promise<CloudBuild | null> {
    return this.json<CloudBuild>(
      `${this.options.endpoint}/v1/${this.parent}/builds/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
  }

  /**
   * New entries since the last read. A page token belongs to one search, so each
   * poll starts a fresh search; an empty page carrying a token is not the end.
   */
  private async *readLog(
    id: string,
    tail: LogTail,
    now: () => Date,
  ): AsyncGenerator<BuildEvent, void, void> {
    const filter = [
      `resource.labels.build_id="${id}"`,
      ...(tail.newest === null
        ? []
        : [
            `timestamp>="${new Date(tail.newest.getTime() - LOG_LATENESS_MS).toISOString()}"`,
          ]),
    ].join(' AND ');

    let token: string | undefined;
    for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
      let answer: { entries?: LogEntry[]; nextPageToken?: string } | null;
      try {
        answer = await this.json(
          `${this.options.logsEndpoint}/v2/entries:list`,
          {
            method: 'POST',
            body: {
              resourceNames: [`projects/${this.options.project}`],
              filter,
              orderBy: 'timestamp asc',
              pageSize: 200,
              ...(token === undefined ? {} : { pageToken: token }),
            },
          },
        );
      } catch {
        // A failed log read never fails the build: the status read decides, and
        // the next poll searches the same window again.
        return;
      }

      for (const entry of answer?.entries ?? []) {
        const key = keyOf(entry);
        if (tail.seen.has(key)) continue;
        tail.seen.add(key);

        const at = timestampOf(entry);
        if (at !== null && (tail.newest === null || at > tail.newest)) {
          tail.newest = at;
        }

        const line = entry.textPayload;
        if (line === undefined || line.trim() === '') continue;
        tail.log += `${line}\n`;
        yield { type: 'log', at: at ?? now(), line };
      }

      token = answer?.nextPageToken;
      if (token === undefined || token === '') return;
    }
  }

  private async json<Result>(
    url: string,
    options: { method: string; body?: unknown },
  ): Promise<Result | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.options.token()}`,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const request = new Request(url, {
      method: options.method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const send = this.options.fetch ?? ((input: Request) => fetch(input));
    const response = await send(request);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `${options.method} ${url} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as Result;
  }
}

/** The prefix is for a person reading the console; a UUID is already a valid tag. */
function tagFor(dispatchId: string): string {
  return `spindrift-${dispatchId}`;
}

interface BuildStep {
  readonly name: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly env?: readonly string[];
}

/** `default` is the build's service account, which holds the registry writer grant. */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** `/workspace` is the only volume a build's steps share. */
const DIGEST_PATH = '/workspace/spindrift-digest';

/**
 * The full image: `sign-and-create` is a `beta` command, and slim images cannot
 * install missing components.
 */
const ATTEST_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:stable';

/** Hosts the step's metadata token can push to. */
function googleRegistryHosts(destinations: readonly string[]): string[] {
  const hosts = destinations.map(
    (destination) => destination.split('/')[0] ?? '',
  );
  return [...new Set(hosts)].filter(isGoogleRegistryHost);
}

function isGoogleRegistryHost(host: string): boolean {
  return host.endsWith('docker.pkg.dev') || host === 'gcr.io';
}

/** Destinations on those hosts, whose manifests the attestation step can read. */
function googleRegistryDestinations(
  destinations: readonly string[],
): readonly string[] {
  return destinations.filter((destination) =>
    isGoogleRegistryHost(destination.split('/')[0] ?? ''),
  );
}

/**
 * Escapes every `$` as `$$`. The build service expands `$NAME` in step fields
 * and rejects names it does not know, and every dollar here is the shell's.
 */
function literalDollars(field: string): string {
  return field.replaceAll('$', '$$$$');
}

/**
 * Mints the step's registry token at run time, so none sits in the submitted
 * build or expires in the queue. It merges into {@link REGISTRY_AUTH_VAR}
 * because the shared program writes its own Docker config from that variable.
 */
function registryAuth(destinations: readonly string[]): string {
  const hosts = googleRegistryHosts(destinations);
  if (hosts.length === 0) return '';

  return `set -eu
token=$(wget -qO- --header 'Metadata-Flavor: Google' ${quote(METADATA_TOKEN_URL)} \\
  | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
# A token that never arrived becomes an empty password and a \`401\` at the
# export, half an hour into a build. It is cheaper to say so here.
[ -n "$token" ] || { echo 'the metadata server issued no access token'; exit 1; }
# Folded \`base64\` output is a header the registry cannot parse, and whether it
# folds is an implementation detail of whichever one the image ships.
auth=$(printf 'oauth2accesstoken:%s' "$token" | base64 | tr -d '\\n')
entries=""
for host in ${hosts.map(quote).join(' ')}; do
  entries="\${entries:+\${entries},}\\"\${host}\\":{\\"auth\\":\\"\${auth}\\"}"
done
# Whatever the route already handed over is kept, because it covers the hosts
# this token cannot. Spliced rather than parsed: the document on the way in is
# \`dockerConfigFor\`'s own \`JSON.stringify\` output, so its outer shape is
# exactly \`{"auths":{…}}\` and there is no jq in a BuildKit image to do better.
if [ -n "\${${REGISTRY_AUTH_VAR}:-}" ]; then
  stored=$(printf '%s' "$${REGISTRY_AUTH_VAR}" | sed -e 's/^{"auths":{//' -e 's/}}$//')
  [ -z "$stored" ] || entries="\${entries},\${stored}"
fi
${REGISTRY_AUTH_VAR}="{\\"auths\\":{\${entries}}}"
export ${REGISTRY_AUTH_VAR}

`;
}

/** Hands the program's `$digest` to the attestation step, so one place parses the metadata. */
function exportDigest(attest: BuildStep | null): string {
  return attest === null ? '' : `\nprintf '%s' "$digest" > ${DIGEST_PATH}\n`;
}

interface SignerKey {
  readonly project: string;
  readonly location: string;
  readonly keyRing: string;
  readonly key: string;
}

const SIGNER_PATTERN =
  /^gcpkms:\/\/projects\/([^/]+)\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/;
const ATTESTOR_PATTERN = /^projects\/([^/]+)\/attestors\/([^/]+)$/;

/**
 * The attestation step, or `null` where none is configured. A malformed signer
 * or attestor throws, so the submit fails with a sentence in the build's log.
 */
function attestStep(
  destinations: readonly string[],
  options: Pick<CloudBuildRouteOptions, 'signer' | 'attestor'>,
): BuildStep | null {
  if (options.attestor === '' || options.signer === '') return null;

  const signer = SIGNER_PATTERN.exec(options.signer);
  if (signer === null) {
    throw new TypeError(
      `the configured signer is not a KMS key reference: ${options.signer}`,
    );
  }
  const attestor = ATTESTOR_PATTERN.exec(options.attestor);
  if (attestor === null) {
    throw new TypeError(
      `the configured attestor is not an attestor reference: ${options.attestor}`,
    );
  }

  const key: SignerKey = {
    project: signer[1] ?? '',
    location: signer[2] ?? '',
    keyRing: signer[3] ?? '',
    key: signer[4] ?? '',
  };
  const attestorProject = quote(attestor[1] ?? '');

  return {
    name: ATTEST_IMAGE,
    entrypoint: 'bash',
    // Otherwise a missing component prompts to install and the step hangs.
    env: ['CLOUDSDK_CORE_DISABLE_PROMPTS=1'],
    args: [
      '-c',
      `set -euo pipefail
digest=$(cat ${DIGEST_PATH})

# The key version has to be named and cannot be read off the attestor: Binary
# Authorization overwrites a PKIX key's id with an API-calculated RFC6920
# fingerprint, so what the attestor reports is a hash rather than the version
# that produced it. \`1\` is the fallback for a caller whose role carries
# \`useToSign\` but not \`list\` — a key with one version and no rotation
# schedule gives the same answer either way.
#
# \`|| true\` is what makes that fallback reachable rather than decorative:
# under \`pipefail\` a refused \`list\` fails the pipeline, and under \`-e\` a
# failed command substitution in an assignment ends the step — so without it
# the caller the fallback exists for dies at this line instead of using it.
version=$(gcloud kms keys versions list \\
  --project=${quote(key.project)} \\
  --location=${quote(key.location)} \\
  --keyring=${quote(key.keyRing)} \\
  --key=${quote(key.key)} \\
  --filter='state=ENABLED' --sort-by=~name --limit=1 \\
  --format='value(name)' 2>/dev/null | sed 's#.*/##' || true)
version="\${version:-1}"
echo "attesting with key version \${version}"

attest() {
  echo "attesting \${1}@\${2}"
  # \`sign-and-create\` refuses a second occurrence for the same artifact-url
  # as a conflict — but an identical rebuild reusing its digest is this
  # pipeline's ordinary behaviour, and "already attested" is the condition
  # this step exists to bring about, not a failure. Any other error still
  # fails the build.
  output=$(gcloud beta container binauthz attestations sign-and-create \\
    --project=${attestorProject} \\
    --artifact-url="\${1}@\${2}" \\
    --attestor=${quote(attestor[2] ?? '')} \\
    --attestor-project=${attestorProject} \\
    --keyversion-project=${quote(key.project)} \\
    --keyversion-location=${quote(key.location)} \\
    --keyversion-keyring=${quote(key.keyRing)} \\
    --keyversion-key=${quote(key.key)} \\
    --keyversion="\${version}" 2>&1) && { printf '%s\\n' "\${output}"; return 0; }
  case "\${output}" in
    *"is the subject of a conflict"*)
      echo "already attested: \${1}@\${2}" ;;
    *)
      printf '%s\\n' "\${output}" >&2; return 1 ;;
  esac
}

# Every manifest the index names, read off the registry.
#
# BuildKit exports an OCI **image index** whenever \`--attest\` is on — which it
# always is (\`buildkit.ts\`) — even for a single platform. So the digest the
# builder reported names an index, and an index is not what a runtime runs:
# Cloud Run resolves it to the child manifest for its own platform *before*
# admission, and Binary Authorization is then asked about a digest nothing
# attested. That reads as \`denied by attestor\` on an artifact that was
# attested, one indirection up, and no amount of re-attesting the index fixes
# it. The children are attested as well so the question the runtime asks has an
# answer whichever digest it resolved to.
#
# A child means a manifest a runtime can run, which is not every entry the
# index names. The same \`--attest\` that makes this an index hangs its own
# manifests off it, and those are not images: \`platform\` is
# \`unknown/unknown\` and the entry is annotated \`vnd.docker.reference.type:
# attestation-manifest\`. Nothing resolves to one and no admission decision is
# ever made about one, so attesting them buys nothing and costs a KMS signing
# operation and an occurrence per destination per build — and buries the
# occurrence that matters in a list an operator has to read while diagnosing a
# refusal.
#
# Selected by what the entry *is*, never by how many there are. "Drop the last
# two" is correct today and wrong the first time a second platform or a third
# attachment appears, with nothing to report it. An entry that names no
# platform at all is kept: unrecognised is not the same as unrunnable, and the
# failure that matters is the one where a runtime resolves to a digest nothing
# attested.
#
# Every media type accepted and not only the index ones, for the same reason: a
# push with no index has to answer this call rather than 404 it, and
# \`manifests\` is simply absent from what comes back.
children() {
  curl --fail --silent --show-error \\
    --header "Authorization: Bearer $(gcloud auth print-access-token)" \\
    --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \\
    "https://\${1%%/*}/v2/\${1#*/}/manifests/\${2}" \\
  | "\${CLOUDSDK_PYTHON:-python3}" -c 'import json, sys
for manifest in json.load(sys.stdin).get("manifests", []):
    annotations = manifest.get("annotations") or {}
    if annotations.get("vnd.docker.reference.type") == "attestation-manifest":
        continue
    platform = manifest.get("platform") or {}
    if platform.get("os") == "unknown" or platform.get("architecture") == "unknown":
        continue
    print(manifest["digest"])'
}

# Once per destination, and for a sharper reason than a signature: an
# attestation is an occurrence bound to an --artifact-url, so one made against
# one registry says nothing about the same digest in another. Binary
# Authorization would refuse the exact image it had already attested, because
# the URL it was asked about is not the URL it was told about.
for destination in ${destinations.map(quote).join(' ')}; do
  attest "$destination" "$digest"
done
${
  googleRegistryDestinations(destinations).length === 0
    ? ''
    : `
# The children, for the vendor's own registries and not for every destination:
# this step holds one metadata token and that is what it authenticates to. A
# destination elsewhere is attested at the index alone, which is all its
# verifier reads — Binary Authorization is not what admits it.
for destination in ${googleRegistryDestinations(destinations).map(quote).join(' ')}; do
  # Assigned before it is looped over, because a failing command substitution
  # in a \`for\` list is not what \`-e\` acts on and one in an assignment is. A
  # registry having a bad moment must not read as an index with no children,
  # which is a green build whose Deploy is refused later by a policy.
  manifests=$(children "$destination" "$digest")
  for child in $manifests; do
    attest "$destination" "$child"
  done
done
`
}`,
    ],
  };
}

/**
 * An entry's identity: `insertId`, else timestamp plus text. The fallback can
 * merge two identical lines written in the same second.
 */
function keyOf(entry: LogEntry): string {
  if (entry.insertId !== undefined && entry.insertId !== '') {
    return entry.insertId;
  }
  return `${entry.timestamp ?? ''} ${entry.textPayload ?? ''}`;
}

function timestampOf(entry: LogEntry): Date | null {
  if (entry.timestamp === undefined) return null;
  const at = new Date(entry.timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}

import { cloudBuildConfigSchema } from '../../config/build-route-schemas.ts';

export const cloudBuildDescriptor = {
  kind: 'cloud-build',
  displayName: 'Cloud Build',
  logo: 'google-cloud',
  buildLevel: 3,
  configSchema: cloudBuildConfigSchema,
  create(config, context) {
    return new CloudBuildRoute({
      name: config.name,
      endpoint: config.endpoint,
      logsEndpoint: config.logsEndpoint,
      project: config.project,
      region: config.region,
      image: config.image,
      zeroConfigFrontend: context.manifest.build.zeroConfigFrontend,
      signer: context.manifest.supplyChain.signer,
      attestor: context.manifest.supplyChain.attestor ?? '',
      token: context.cloud,
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
  },
} satisfies BuildRouteDescriptor;
