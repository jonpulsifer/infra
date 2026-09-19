/**
 * One sandbox, one prompt, one teardown — with no Discord in the loop.
 *
 *   bun run smoke          mint, prompt, tear down, print the wall clock
 *   bun run smoke -- --kill  delete the Sandbox mid-turn and report the transport
 *
 * It needs a kubeconfig or a ServiceAccount mount that can reach the cluster,
 * `MATE_SANDBOX_IMAGE`, and `MATE_SANDBOX_NAMESPACE` when the context's
 * namespace is not the one sandboxes are minted in.
 */
import { StreamClosed } from './acp.ts';
import { readSandboxConfig } from './config.ts';
import { discoverKube, Kube } from './kube.ts';
import { jsonLog, plain } from './log.ts';
import type { PromptSink, SandboxRef, Update } from './sandbox.ts';
import { KubeSandboxes, waitForPodGone } from './sandboxes.ts';
import type { ThreadRef } from './surface.ts';

const PROMPT =
  'Read AGENTS.md and reply with the file:line of the rule about `tofu apply`';
const KILL_FALLBACK_MS = 30_000;

const kill = process.argv.includes('--kill');
const config = readSandboxConfig(process.env);
const kube = new Kube(await discoverKube());
const guildId = process.env.MATE_GUILD_ID?.trim() || '0';
const thread: ThreadRef = {
  surface: 'discord',
  id: `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`,
  channelId: process.env.MATE_ALLOWED_CHANNEL_IDS?.split(',')[0]?.trim() || '0',
};

const sandboxes = new KubeSandboxes({ kube, config, guildId, log: jsonLog });

class Streaming implements PromptSink {
  firstTextAt: number | null = null;
  text = '';
  constructor(private readonly startedAt: number) {}
  update(update: Update): void {
    if (update.kind === 'status') {
      if (update.line) process.stderr.write(`\n[${update.line}]\n`);
      return;
    }
    this.firstTextAt ??= Date.now() - this.startedAt;
    this.text += update.delta;
    process.stdout.write(update.delta);
  }
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
}

function report(rows: [string, number | null][]): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  process.stderr.write('\n');
  for (const [label, ms] of rows) {
    process.stderr.write(`${label.padEnd(width)}  ${seconds(ms)}\n`);
  }
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof StreamClosed) {
    return {
      transport: 'StreamClosed',
      code: error.close.code,
      reason: error.close.reason,
      status: error.close.status,
    };
  }
  return {
    transport: error instanceof Error ? error.name : typeof error,
    message: plain(error),
  };
}

let sandbox: SandboxRef | null = null;
let pod: string | null = null;
let failed = false;

try {
  jsonLog.info('smoke starting', {
    namespace: sandboxes.namespace,
    image: config.image,
    runtimeClass: config.runtimeClass,
    model: config.model,
    thread: thread.id,
    mode: kill ? 'kill-mid-turn' : 'round-trip',
  });

  const mintedAt = Date.now();
  sandbox = await sandboxes.mint(thread);
  const readyMs = Date.now() - mintedAt;
  pod = await sandboxes.podOf(sandbox);
  jsonLog.info('sandbox ready', { sandbox: sandbox.name, pod });

  const attachedAt = Date.now();
  const session = await sandboxes.attach(sandbox);
  const attachMs = Date.now() - attachedAt;
  jsonLog.info('acp attached', { session: session.id });

  const promptedAt = Date.now();
  const sink = new Streaming(promptedAt);
  let killedAt: number | null = null;
  let armed: ReturnType<typeof setInterval> | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  if (kill) {
    const name = sandbox.name;
    const fire = () => {
      if (killedAt !== null) return;
      killedAt = Date.now();
      void deleteSandbox(name);
    };
    // Mid-turn means once the model has started answering, with a fallback in
    // case it never does.
    armed = setInterval(() => {
      if (sink.firstTextAt !== null) fire();
    }, 250);
    fallback = setTimeout(fire, KILL_FALLBACK_MS);
  }

  let outcome: Record<string, unknown>;
  let finalMs: number | null = null;
  try {
    const result = await sandboxes.prompt(session, PROMPT, sink);
    finalMs = Date.now() - promptedAt;
    outcome = { stopReason: result.stopReason, error: result.error ?? null };
  } catch (error) {
    finalMs = Date.now() - promptedAt;
    outcome = describe(error);
    failed = !kill;
  } finally {
    if (armed) clearInterval(armed);
    if (fallback) clearTimeout(fallback);
  }
  process.stdout.write('\n');
  jsonLog.info('turn ended', {
    ...outcome,
    chars: sink.text.length,
    killedMidTurn: killedAt !== null,
  });

  // In kill mode the delete already went out mid-turn; the teardown below is
  // then the 404-tolerant wait for what it started.
  const deletedAt = killedAt ?? Date.now();
  await sandboxes.teardown(sandbox);
  const sandboxGoneMs = Date.now() - deletedAt;
  await waitForPodGone(kube, sandboxes.namespace, pod);
  const podGoneMs = Date.now() - deletedAt;
  sandbox = null;

  report([
    ['create → Ready', readyMs],
    ['Ready → ACP session', attachMs],
    ['prompt → first token', sink.firstTextAt],
    ['prompt → final', finalMs],
    ['delete → Sandbox gone', sandboxGoneMs],
    ['delete → pod gone', podGoneMs],
  ]);
} catch (error) {
  failed = true;
  jsonLog.error('smoke failed', describe(error));
} finally {
  if (sandbox) {
    await sandboxes
      .teardown(sandbox)
      .catch((error) => jsonLog.warn('teardown failed', describe(error)));
  }
}

async function deleteSandbox(name: string): Promise<void> {
  jsonLog.warn('deleting the sandbox mid-turn', { sandbox: name });
  const response = await kube.request(
    `/apis/agents.x-k8s.io/v1beta1/namespaces/${sandboxes.namespace}/sandboxes/${name}`,
    { method: 'DELETE' },
  );
  await response.body?.cancel().catch(() => {});
}

process.exitCode = failed ? 1 : 0;
