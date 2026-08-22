/**
 * Deploying a function to Cloud Run functions (gen2).
 *
 * The archive holds three files — the author's `index.mjs`, the Functions
 * Framework shim from `shim.ts`, and a manifest — uploaded to the vessel's own
 * source bucket under its digest. The digest is the object name, so an
 * unchanged function re-uploads to the same place instead of leaving one object
 * per deploy behind.
 *
 * **Public by the Service's own field, not by an IAM binding.** A function is a
 * Cloud Run Service underneath, and this installation's org policy admits no
 * `allUsers` principal — so openness is `invokerIamDisabled` on the Service, the
 * same lever `cloudrun/service.ts` pulls for a public Component.
 *
 * `tail` polls Cloud Logging rather than streaming: the API has no watch, and a
 * function's entries are ordinary `cloud_run_revision` entries — which is why
 * the reading helpers are the deploy adapter's, in `cloudrun/logs.ts`.
 *
 * The function's environment is `serviceConfig.environmentVariables` — plain
 * environment on the Service, so anyone who can read the project reads the
 * values. It is always sent, empty map included, because an absent field on a
 * PATCH under this update mask would leave a removed variable in place.
 *
 * ponytail: no min instances. That is a field on `serviceConfig` when a
 * function needs one.
 */

import type { Fetcher, TokenProvider } from '../adapters/deploy/cloud/http.ts';
import { CloudHttp } from '../adapters/deploy/cloud/http.ts';
import {
  type CloudLogPage,
  type CloudLogRecord,
  cloudLogRecord,
} from '../adapters/deploy/cloudrun/logs.ts';
import {
  FunctionDeployError,
  type FunctionDeployer,
  type FunctionEnv,
  type FunctionLogEntry,
  type FunctionTarget,
  workloadName,
} from './contract.ts';
import { packageJson, SHIM, SHIM_ENTRY_POINT } from './shim.ts';
import { zip } from './zip.ts';

const DEFAULT_FUNCTIONS_ENDPOINT = 'https://cloudfunctions.googleapis.com';
const DEFAULT_RUN_ENDPOINT = 'https://run.googleapis.com';
const DEFAULT_STORAGE_ENDPOINT = 'https://storage.googleapis.com';
const DEFAULT_LOGS_ENDPOINT = 'https://logging.googleapis.com';

/** The runtime the shim is written against. */
const RUNTIME = 'nodejs22';

/** How often the build operation is asked whether it is finished. */
const OPERATION_POLL_MS = 3_000;

/**
 * How long a deploy is waited on.
 *
 * A gen2 deploy is a container build, so the ceiling is minutes rather than
 * seconds — but it is a ceiling, because the alternative to giving up is a
 * request that never answers.
 */
const OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;

const LOG_POLL_MS = 2_000;

/** How far back the first log read looks, so a tail opens with context. */
const LOG_LOOKBACK_MS = 60_000;

export interface CloudRunFunctionsOptions {
  readonly token: TokenProvider;
  readonly project: string;
  readonly region: string;
  /** Where the source archive is staged for the build. */
  readonly sourceBucket: string;
  readonly runtimeServiceAccount?: string;
  readonly functionsEndpoint?: string;
  readonly runEndpoint?: string;
  readonly storageEndpoint?: string;
  readonly logsEndpoint?: string;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly fetch?: Fetcher;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One function, as much of the v2 resource as this reads. */
interface CloudFunction {
  readonly url?: string;
  readonly serviceConfig?: { readonly uri?: string };
}

/** The long-running operation a write answers with. */
interface FunctionOperation {
  readonly name?: string;
  readonly done?: boolean;
  readonly error?: { readonly message?: string };
  readonly response?: CloudFunction;
}

export class CloudRunFunctions implements FunctionDeployer {
  readonly target: FunctionTarget = 'cloud-run-functions';

  constructor(private readonly options: CloudRunFunctionsOptions) {}

  async deploy(
    name: string,
    source: string,
    env: FunctionEnv,
  ): Promise<{ readonly url: string }> {
    const id = workloadName(name);
    const encoder = new TextEncoder();
    const bytes = zip([
      { name: 'index.mjs', bytes: encoder.encode(source) },
      { name: 'shim.mjs', bytes: encoder.encode(SHIM) },
      { name: 'package.json', bytes: encoder.encode(packageJson(id)) },
    ]);
    const object = `functions/${id}/${digestOf(bytes)}.zip`;

    const storage = this.options.storageEndpoint ?? DEFAULT_STORAGE_ENDPOINT;
    const uploaded = await this.http(storage).upload({
      url: `${storage}/upload/storage/v1/b/${this.options.sourceBucket}/o?uploadType=media&name=${encodeURIComponent(object)}`,
      bytes,
      contentType: 'application/zip',
    });
    if (!uploaded.ok) {
      throw new FunctionDeployError(
        `staging ${object} in ${this.options.sourceBucket} failed: ${uploaded.message}`,
      );
    }

    const body = {
      buildConfig: {
        runtime: RUNTIME,
        entryPoint: SHIM_ENTRY_POINT,
        source: {
          storageSource: { bucket: this.options.sourceBucket, object },
        },
      },
      serviceConfig: {
        ingressSettings: 'ALLOW_ALL',
        environmentVariables: env,
        maxInstanceCount: 2,
        availableMemory: '256Mi',
        timeoutSeconds: 60,
        ...(this.options.runtimeServiceAccount === undefined
          ? {}
          : { serviceAccountEmail: this.options.runtimeServiceAccount }),
      },
      labels: { 'spindrift-function': name },
    };

    // Read before write: the API has separate verbs for the first deploy and
    // every one after it, and a create against an existing function is an
    // `ALREADY_EXISTS` rather than an update.
    const functions = this.http(
      this.options.functionsEndpoint ?? DEFAULT_FUNCTIONS_ENDPOINT,
    );
    const existing = await functions.json<CloudFunction>({
      method: 'GET',
      path: `/v2/${this.parent()}/functions/${id}`,
    });
    if (
      !existing.ok &&
      !(existing.kind === 'status' && existing.status === 404)
    ) {
      throw new FunctionDeployError(
        `reading ${id} in ${this.options.project} failed: ${existing.message}`,
      );
    }

    const written = existing.ok
      ? await functions.json<FunctionOperation>({
          method: 'PATCH',
          path: `/v2/${this.parent()}/functions/${id}`,
          query: { updateMask: 'buildConfig,serviceConfig,labels' },
          body,
        })
      : await functions.json<FunctionOperation>({
          method: 'POST',
          path: `/v2/${this.parent()}/functions`,
          query: { functionId: id },
          body,
        });
    if (!written.ok) {
      throw new FunctionDeployError(
        `deploying ${id} failed: ${written.message}`,
      );
    }

    const finished = await this.settle(functions, written.value);
    await this.open(id);

    const url =
      finished.response?.url ??
      finished.response?.serviceConfig?.uri ??
      (await this.address(functions, id));
    if (url === null) {
      throw new FunctionDeployError(
        `${id} deployed without an address to reach it at`,
      );
    }
    return { url };
  }

  async remove(name: string): Promise<void> {
    const id = workloadName(name);
    // The operation is not waited on: the function is gone from the API's point
    // of view as soon as the delete is accepted, and a caller removing a row
    // has nothing to do with the minutes the teardown takes.
    const deleted = await this.http(
      this.options.functionsEndpoint ?? DEFAULT_FUNCTIONS_ENDPOINT,
    ).json({
      method: 'DELETE',
      path: `/v2/${this.parent()}/functions/${id}`,
    });
    if (deleted.ok) return;
    if (deleted.kind === 'status' && deleted.status === 404) return;
    throw new FunctionDeployError(`removing ${id} failed: ${deleted.message}`);
  }

  async *tail(
    name: string,
    signal: AbortSignal,
  ): AsyncGenerator<FunctionLogEntry, void, void> {
    const id = workloadName(name);
    const logs = this.http(this.options.logsEndpoint ?? DEFAULT_LOGS_ENDPOINT);
    const filter = [
      'resource.type="cloud_run_revision"',
      `resource.labels.service_name="${id}"`,
      `resource.labels.location="${this.options.region}"`,
    ].join(' AND ');
    let after: CloudLogRecord | null = null;
    const since = new Date(Date.now() - LOG_LOOKBACK_MS).toISOString();

    while (!signal.aborted) {
      const page = await logs.json<CloudLogPage>({
        method: 'POST',
        path: '/v2/entries:list',
        body: {
          resourceNames: [`projects/${this.options.project}`],
          filter: `${filter} AND timestamp>="${after?.at ?? since}"`,
          orderBy: 'timestamp asc',
          pageSize: 200,
        },
      });
      if (page.ok) {
        for (const entry of page.value.entries ?? []) {
          const record = cloudLogRecord(entry);
          if (record === null) continue;
          // The filter is inclusive of its own timestamp, so the entry that set
          // the cursor comes back on every poll until something newer does.
          if (
            after !== null &&
            (record.at < after.at ||
              (record.at === after.at && record.insertId <= after.insertId))
          ) {
            continue;
          }
          after = record;
          yield {
            at: record.at,
            line: record.line,
            level: levelOf(entry.severity),
          };
        }
      }
      if (signal.aborted) return;
      await this.wait(LOG_POLL_MS);
    }
  }

  /** `projects/<p>/locations/<r>` — the parent every call hangs off. */
  private parent(): string {
    return `projects/${this.options.project}/locations/${this.options.region}`;
  }

  private http(baseUrl: string): CloudHttp {
    return new CloudHttp({
      baseUrl,
      token: this.options.token,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }

  private async wait(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) {
      await this.options.sleep(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Poll the build operation until it is finished, or give up saying so. */
  private async settle(
    functions: CloudHttp,
    started: FunctionOperation,
  ): Promise<FunctionOperation> {
    let operation = started;
    let waited = 0;
    while (operation.done !== true) {
      if (operation.name === undefined) {
        throw new FunctionDeployError(
          'the API accepted the deploy without naming an operation to follow',
        );
      }
      if (waited >= OPERATION_TIMEOUT_MS) {
        throw new FunctionDeployError(
          `the build was still running after ${OPERATION_TIMEOUT_MS / 60_000} minutes`,
        );
      }
      await this.wait(OPERATION_POLL_MS);
      waited += OPERATION_POLL_MS;
      const polled = await functions.json<FunctionOperation>({
        method: 'GET',
        path: `/v2/${operation.name}`,
      });
      if (!polled.ok) {
        throw new FunctionDeployError(
          `following the deploy failed: ${polled.message}`,
        );
      }
      operation = polled.value;
    }
    if (operation.error !== undefined) {
      throw new FunctionDeployError(
        operation.error.message ?? 'the build failed without saying why',
      );
    }
    return operation;
  }

  /** Take the invoker check off the Service the function runs as (§9). */
  private async open(id: string): Promise<void> {
    const opened = await this.http(
      this.options.runEndpoint ?? DEFAULT_RUN_ENDPOINT,
    ).json({
      method: 'PATCH',
      path: `/v2/${this.parent()}/services/${id}`,
      query: { updateMask: 'invokerIamDisabled' },
      body: { invokerIamDisabled: true },
    });
    if (!opened.ok) {
      throw new FunctionDeployError(
        `${id} deployed but could not be opened to the public: ${opened.message}. A function is public through the Service's own \`invokerIamDisabled\`, which \`run.managed.requireInvokerIam\` can forbid.`,
      );
    }
  }

  /** The address, when the operation's own response did not carry one. */
  private async address(
    functions: CloudHttp,
    id: string,
  ): Promise<string | null> {
    const read = await functions.json<CloudFunction>({
      method: 'GET',
      path: `/v2/${this.parent()}/functions/${id}`,
    });
    if (!read.ok) return null;
    return read.value.url ?? read.value.serviceConfig?.uri ?? null;
  }
}

function digestOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function levelOf(severity: string | undefined): FunctionLogEntry['level'] {
  switch (severity) {
    case 'ERROR':
    case 'CRITICAL':
    case 'ALERT':
    case 'EMERGENCY':
      return 'error';
    case 'WARNING':
      return 'warn';
    case 'DEBUG':
      return 'debug';
    case 'INFO':
      return 'info';
    default:
      return 'log';
  }
}
