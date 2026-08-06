/**
 * The cloud build route (§4).
 *
 * §4 names three routes and this is the middle one: "a cloud build service", in
 * §14's shared artifacts project, next to the registry every artifact is pushed
 * to. It is the route with the strongest isolation claim — a managed worker the
 * connected repository's maintainers cannot reach — which is why it is the only
 * one this installation can honestly offer above L2.
 *
 * `LIVE_TEXT`, and it is earned rather than declared: the build service writes
 * its steps' output to a log service that can be read while the build runs, so
 * the timeline fills in as it goes (§4's amendment). The read is a poll with a
 * page cursor and not a stream, for the same reason `observe` is a poll — a
 * long-lived connection over the uplink is a connection that stays open while
 * delivering nothing.
 *
 * **What it submits is the shared BuildKit program**, not the service's own
 * source-to-image path. That is §4's "build is always separate from deploy"
 * applied one level down: a backend's convenience path is a second engine with
 * its own frontends, its own defaults, and its own idea of what a website is,
 * and having one would make "one engine, two frontends" false the moment a
 * build moved between routes.
 *
 * **Two things the route adds around that program**, both of which the hosted
 * route gets from its runner and this one has to arrange:
 *
 *   * A registry credential. The shared program exports with `push=true`, and
 *     nothing in a build step authorizes that by itself — so the step mints its
 *     own identity from the metadata server and writes the Docker config
 *     BuildKit reads.
 *   * A Binary Authorization attestation, as a second step. §16's registry
 *     signature is core's and core makes it; the attestation is the *other*
 *     half of the same key, an occurrence in the authority's project rather
 *     than an object in the registry, and a cloud Target's admission reads that
 *     one. It runs after the report line and before the build concludes, so a
 *     failure to attest fails the build rather than reporting an artifact no
 *     Target will admit.
 */

import { z } from 'zod';
import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import {
  buildKitProgramFor,
  dockerConfigFor,
  quote,
  REGISTRY_AUTH_VAR,
} from './buildkit.ts';
import type {
  BuildAdapter,
  BuildEvent,
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

/** The transport, in the shape `fetch` already has. */
export type Fetcher = (request: Request) => Promise<Response>;

/** Mints a bearer token per request. Never a stored credential (§13). */
export type TokenProvider = () => string | Promise<string>;

/** One build, as much of it as this route reads. */
interface CloudBuild {
  readonly id: string;
  readonly status?: string;
  readonly statusDetail?: string;
}

/** One log entry, as much of it as this route reads. */
interface LogEntry {
  /**
   * The log service's own identity for this entry. It is what makes re-reading
   * a window cheap: the same entry seen twice is recognised rather than
   * re-emitted, so the route never needs a cursor it cannot trust.
   */
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly timestamp?: string;
}

/**
 * How far behind the newest entry already read a fresh search reaches.
 *
 * Entries are ingested out of order, so a window that started exactly at the
 * newest timestamp would step over anything that arrived late. A minute is
 * generous against the log service's own ingestion latency, and re-reading a
 * minute costs nothing because {@link keyOf} recognises what was already
 * emitted.
 */
const LOG_LATENESS_MS = 60_000;

/**
 * Pages one search follows before leaving the rest to the next poll.
 *
 * A bound rather than a limit anyone should hit: the next poll re-reads the
 * window anyway, so stopping early loses nothing but a few seconds of latency.
 */
const MAX_LOG_PAGES = 50;

/**
 * How long a concluded build's log is drained for before the route gives up on
 * the report.
 *
 * The build being over does not mean its log is: ingestion runs behind the
 * writer, and the report line is written in the final seconds of the run. This
 * is the only budget spent waiting for something that has already happened.
 */
const LOG_TAIL_TIMEOUT_MS = 60_000;

/** What the route carries between reads of one build's log. */
interface LogTail {
  /** Entries already emitted, by {@link keyOf}. */
  readonly seen: Set<string>;
  /** The newest entry timestamp seen, which anchors the next search's window. */
  newest: Date | null;
  /** Everything emitted, joined — what {@link parseBuildReport} reads. */
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
  /** The BuildKit image the build step runs. Pinned by the installation. */
  readonly image: string;
  /** The zero-config BuildKit frontend the installation pinned (§4). */
  readonly zeroConfigFrontend: string;
  /**
   * The installation's signing key, as `supplyChain.signer` names it.
   *
   * Here for the attestation and not for a signature: core signs the digest it
   * admits (`supply-chain/sign.ts`) and puts a cosign signature in the
   * repository itself. What core cannot do is the *other* half — see
   * {@link attestor}.
   */
  readonly signer: string;
  /**
   * `projects/<project>/attestors/<name>`, or empty where the installation
   * enforces no Binary Authorization policy.
   *
   * A cloud runtime's admission reads an **attestation** — an occurrence on a
   * note in the authority's own project — and not the registry signature core
   * makes. One key, two verifiers, two artifacts, and a Target that enforces
   * the second refuses a perfectly signed image that lacks it. The hosted route
   * has carried this since it was written; without it here a cloud build is an
   * artifact no such Target will admit.
   */
  readonly attestor: string;
  readonly token: TokenProvider;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
}

/**
 * The statuses that mean the build is over.
 *
 * `EXPIRED` is in here and reads oddly: it is what a build that sat in the
 * queue past its own deadline becomes, so it is terminal even though nothing
 * ever ran.
 */
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
  /**
   * §16's profile level. A managed, ephemeral worker nobody outside the build
   * service can reach, running a program submitted by an authenticated caller —
   * that is the L3 claim this service makes for its own builds, and the profile
   * is a guarantee about the *route*. Whether a concrete Build achieved it is
   * Task 26's question, asked before signing and never taken on trust.
   */
  readonly buildLevel: BuildLevel = 3;
  /**
   * The build step's own environment is a place a secret can go: the step runs
   * in a worker nobody outside the build service reaches, and the value is
   * scoped to that container rather than to the build's own arguments — which
   * are what a reader of the build resource sees.
   */
  readonly carriesRegistryCredential = true;
  /**
   * One vendor's registries, because that is what the metadata server issues a
   * token for. Everything else this route publishes to needs a stored
   * credential, and without one it is simply not a destination this route has —
   * see {@link publishableRegistries}. That is why a cloud build lands in the
   * artifact registry by default: not a preference, but the honest extent of
   * what its own identity authorizes.
   */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [
    'artifactRegistry',
  ];

  constructor(private readonly options: CloudBuildRouteOptions) {
    this.name = options.name;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;

    if (source.origin.type === 'repo') {
      // The bundle was staged once and every route fetches it (§15); a route
      // that cloned again would build a second tree from the same commit and
      // give the receipt nothing to join against.
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
      build = await this.submit(program, spec);
    } catch (error) {
      // §4 story 48: the failure before the build step has to be readable as
      // text, not as an empty log and a spinner.
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
        return buildFailed(
          logs,
          'TIMEOUT',
          `build ${build.id} did not finish within the build budget`,
          { buildId: build.id, status },
        );
      }
      await budget.tick();
    }

    // The log read above happened *before* the status read that ended the loop,
    // so everything the build wrote in its last seconds is still unread — and
    // that is precisely the region that carries the report (`report.ts`: the
    // result travels the same way the logs do). A loop that stopped here would
    // record a green build as `succeeded but reported no artifact`, so the read
    // after the conclusion is the load-bearing one, not a courtesy.
    const drain = deadlineFrom({
      ...this.options,
      timeoutMs: LOG_TAIL_TIMEOUT_MS,
    });
    for (;;) {
      yield* this.readLog(build.id, tail, now);
      // A red build's report is not coming; one final read for the operator's
      // sake is the whole of what it is owed.
      if (status !== 'SUCCESS') break;
      if (parseBuildReport(tail.log) !== null) break;
      if (drain.expired()) break;
      await drain.tick();
    }

    const log = tail.log;

    if (status !== 'SUCCESS') {
      // The service's own `TIMEOUT` is core's `TIMEOUT` — a build that ran out
      // of its own budget indicts nobody either (§6's dash).
      return buildFailed(
        logs,
        status === 'TIMEOUT' || status === 'EXPIRED'
          ? 'TIMEOUT'
          : 'BUILD_FAILED',
        statusDetail ?? `build ${build.id} ended ${status}`,
        { buildId: build.id, status },
      );
    }

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
        // The build's own record of the run — §16's backend provenance, which
        // core verifies against the Target's minimum before signing. The route
        // reports it and never interprets it.
        statement: { build: build.id, project: this.options.project },
      },
    });
  }

  /** `projects/<p>/locations/<r>` — the parent every call hangs off. */
  private get parent(): string {
    return `projects/${this.options.project}/locations/${this.options.region}`;
  }

  private async submit(program: string, spec: BuildSpec): Promise<CloudBuild> {
    const attest = attestStep(spec.destinations, this.options);
    const dockerConfig = dockerConfigFor(spec.registryAuth);
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
            // On the step's environment and never in `args`: the arguments are
            // the program, and the program is what a reader of this build
            // resource sees in full. See REGISTRY_AUTH_VAR.
            ...(dockerConfig === null
              ? {}
              : {
                  env: [literalDollars(`${REGISTRY_AUTH_VAR}=${dockerConfig}`)],
                }),
          },
          ...(attest === null
            ? []
            : [{ ...attest, args: attest.args.map(literalDollars) }]),
        ],
        // Read, never pushed: the build writes to the log service and this
        // route polls it. Nothing is posted back to Spindrift (§4).
        options: { logging: 'CLOUD_LOGGING_ONLY' },
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
   * Everything the build's log has gained since the last read, as events.
   *
   * **One poll is one search.** `entries.list`'s `nextPageToken` is a
   * continuation of *this* search — "retrieve the next batch of results from
   * the preceding call to this method" — and not a watermark on a live log. A
   * route that saved one and presented it seconds later would be paginating a
   * snapshot of the past, so the token is followed to the end of the search it
   * belongs to and then dropped.
   *
   * What replaces it is a timestamp window plus per-entry identity: each poll
   * re-searches the last {@link LOG_LATENESS_MS} and {@link keyOf} drops what
   * was already emitted. That is what tolerates out-of-order ingestion, which a
   * cursor never did.
   *
   * **An empty page carrying a token is not a caught-up log.** The vendor is
   * explicit that it means "the search found no log entries so far but it did
   * not have time to search all the possible log entries", so the token is
   * followed rather than read as an end.
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
        // A log service having a bad moment must not fail a build that is
        // otherwise going fine — the status read is the authority on whether it
        // is going fine, and the next pass searches the same window again.
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

/** One step of a submitted build, as much of it as this route composes. */
interface BuildStep {
  readonly name: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly env?: readonly string[];
}

/**
 * Where the metadata server hands a step its own identity as a bearer token.
 *
 * `default` is the build's service account, which is the account the writer
 * grant on the registry names — so the credential the push needs is the one
 * identity this step already runs as, and no credential is stored anywhere
 * (§13).
 */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * The one path two steps of a build share.
 *
 * `/workspace` is a volume across a build's steps; everything else a step
 * writes is its own container's. So a digest produced by the builder and read
 * by the attestation travels here and nowhere else.
 */
const DIGEST_PATH = '/workspace/spindrift-digest';

/**
 * The tool image the attestation step runs.
 *
 * Not an installation choice, which is why it is not a manifest value beside
 * the BuildKit image: `sign-and-create` is one vendor's subcommand against one
 * vendor's API, and the vendor ships exactly one image carrying it. The full
 * image rather than `:slim`, because the subcommand lives on the `beta`
 * surface and these images have their component manager disabled — a slim
 * image cannot install what it is missing, it can only fail asking.
 */
const ATTEST_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:stable';

/**
 * The registry hosts a build step's own identity can authorize a push to.
 *
 * Spelled out rather than "every host", for the same reason the hosted route
 * splits its logins: this token authenticates to one vendor's registries and
 * to nothing else. A destination on some other host is **not** silently
 * dropped — it reaches the push with no credential and fails there, naming
 * itself, which is the failure an operator can act on.
 */
function googleRegistryHosts(destinations: readonly string[]): string[] {
  const hosts = destinations.map(
    (destination) => destination.split('/')[0] ?? '',
  );
  return [...new Set(hosts)].filter(isGoogleRegistryHost);
}

function isGoogleRegistryHost(host: string): boolean {
  return host.endsWith('docker.pkg.dev') || host === 'gcr.io';
}

/**
 * The destinations the attestation step can read a manifest back out of.
 *
 * Same boundary as {@link googleRegistryHosts} and for the same reason — one
 * metadata token, one vendor's registries — but by destination rather than by
 * host, because what the step reads is a repository's manifest and not a host.
 */
function googleRegistryDestinations(
  destinations: readonly string[],
): readonly string[] {
  return destinations.filter((destination) =>
    isGoogleRegistryHost(destination.split('/')[0] ?? ''),
  );
}

/**
 * The registry credential the build step mints for itself before it builds.
 *
 * The shared program exports with `push=true` and BuildKit reads its registry
 * credentials from a Docker config — so without this the build runs to
 * completion and dies at the export with a `401`, which reads as a broken
 * builder rather than as a missing credential. The cloud builder is the route
 * that has to do this itself: the hosted one logs in with the run's own token,
 * and the in-cluster one runs as a service account the registry already
 * trusts.
 *
 * Minted by the step and not passed to it. A credential composed here would
 * be a credential in a submitted build body, readable by anyone who can read
 * the build — and it would be minted at submit time and expire mid-queue.
 *
 * **It folds into {@link REGISTRY_AUTH_VAR} rather than writing a Docker config
 * of its own**, and that is the load-bearing part. This installation pushes to
 * several registries (§16, `BuildSpec.destinations`), and the two halves of
 * that push authorize differently: the metadata token covers the vendor's own
 * registries and a *stored* credential covers the ones no federation reaches.
 * A prelude that wrote `$DOCKER_CONFIG/config.json` itself was overwritten a
 * few lines later by the shared program, which does `DOCKER_CONFIG=$(mktemp
 * -d)` whenever the variable is set — so an installation holding a stored
 * credential silently lost the vendor half and 401'd on the artifact registry
 * at the export, after the whole build. One writer, one document, both halves.
 */
/**
 * Every dollar in a step's fields, escaped for the build service's template
 * engine.
 *
 * The service expands `$UPPERCASE` and `${UPPERCASE}` in a submitted step as
 * substitutions and refuses a template naming one it does not know — observed
 * live: the prelude's `"$SPINDRIFT_REGISTRY_AUTH"` failed the whole submit
 * with "not a valid built-in substitution". Nothing submitted here *is* a
 * substitution — the programs are shell, and every dollar is the shell's —
 * so every dollar is escaped uniformly (`$$` is the service's literal-dollar
 * escape) rather than this file knowing which spellings the template grammar
 * happens to claim.
 */
function literalDollars(field: string): string {
  return field.replaceAll('$', '$$$$');
}

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

/**
 * The one line the builder adds for the step after it.
 *
 * `$digest` is the shared program's own variable, set from the exporter's
 * metadata a few lines above — this appends to that program rather than
 * re-deriving it, because two places parsing one metadata file is two places
 * that can disagree about what was built. Nothing is written where no second
 * step will read it.
 */
function exportDigest(attest: BuildStep | null): string {
  return attest === null ? '' : `\nprintf '%s' "$digest" > ${DIGEST_PATH}\n`;
}

/** A KMS key, as the four flags `sign-and-create` wants it in. */
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
 * The attestation step, or `null` where this installation asked for none.
 *
 * A malformed value **throws** rather than being skipped. Both halves are one
 * fact an operator configured, and the two ways of getting this wrong land in
 * very different places: a submit that fails here is a sentence in the build's
 * own log, while a quiet skip is a green build whose Deploy is refused later by
 * an admission webhook whose message is about a policy rather than about this
 * installation's manifest.
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
    // Without this a component the image does not carry stops to ask whether
    // to install it, and a prompt in a build step is a hang followed by a
    // timeout.
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
 * What makes two reads of the same entry the same entry.
 *
 * `insertId` is the log service's own identity and is what this relies on. The
 * fallback exists because an entry without one still has to be deduplicated
 * somehow, and it deliberately collapses two identical lines written in the
 * same second — losing a duplicated line is a smaller wrong than emitting the
 * whole window again on every poll.
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

export const cloudBuildDescriptor = {
  kind: 'cloud-build',
  displayName: 'Cloud Build',
  logo: 'google-cloud',
  buildLevel: 3,
  configSchema: z
    .object({
      name: z.string().trim().min(1),
      adapter: z.literal('cloud-build'),
      endpoint: z.url(),
      logsEndpoint: z.url(),
      project: z.string().trim().min(1),
      region: z.string().trim().min(1),
      image: z.string().trim().min(1),
    })
    .strict(),
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

