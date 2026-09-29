/**
 * One turn's news as the surfaces draw it: pi's events and the lease's become
 * `Update`s. Tool calls go out both as cards and as the status line; each
 * surface shows the one it can.
 */
import type { AgentMessage, HarnessEvent } from '@earendil-works/pi-agent-core';
import type { Clock, Handle } from './clock.ts';
import {
  type LeaseEvent,
  type MintStep,
  SANDBOX_CARD_ID,
  WORKSPACE,
} from './lease.ts';
import type { Instruments } from './metrics.ts';
import {
  CONNECTING,
  MINT_FAILED,
  MINT_STEPS,
  SANDBOX_LOST,
  SANDBOX_READY,
  WAITING,
} from './notices.ts';
import { redact } from './redact.ts';
import { oneLine } from './reply.ts';
import { REASONS, type Route, type RouteEvent } from './route.ts';
import type { PromptSink, Update } from './sandbox.ts';
import type { ToolCall } from './surface.ts';

export const THINKING = 'thinking…';
/** A lease quicker than this never shows its card. */
export const CARD_DELAY_MS = 1_000;
export const COMMAND_TITLE_MAX = 80;

const PATH_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit']);
/** Steps that always take seconds, so their card is drawn at once. */
const SLOW_STEPS: ReadonlySet<MintStep> = new Set([
  'creating',
  'booting',
  'adopting',
]);
const KTHX_PREFIX = 'kthx_';

function firstLine(text: string): string {
  const line = text.split('\n').find((one) => one.trim()) ?? '';
  return line.length > COMMAND_TITLE_MAX
    ? `${line.slice(0, COMMAND_TITLE_MAX - 1)}…`
    : line;
}

function field(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function relative(path: string): string {
  if (path === WORKSPACE) return '.';
  return path.startsWith(`${WORKSPACE}/`)
    ? path.slice(WORKSPACE.length + 1)
    : path;
}

/**
 * What a card calls a tool call: pi gives no title, and its arguments can
 * carry a secret into a public thread, so every title is redacted.
 */
export function toolTitle(name: string, args: unknown): string {
  let title = name;
  if (name === 'bash') {
    const command = field(args, 'command');
    // Redacted before the cut: a cut secret is too short to match the shape.
    title = `$ ${command === null ? '…' : firstLine(redact(command))}`;
  } else if (PATH_TOOLS.has(name)) {
    const path = field(args, 'path');
    title = path === null ? name : `${name} ${relative(path)}`;
  } else if (name.startsWith(KTHX_PREFIX)) {
    title = `kthx: ${name.slice(KTHX_PREFIX.length)}`;
  }
  return oneLine(redact(title));
}

/**
 * The `sandbox` card: drawn at once when the lease has to wait, mint or
 * adopt, and otherwise only when it takes longer than `CARD_DELAY_MS`.
 */
export class SandboxCard {
  private title: string | null = null;
  private shown = false;
  private timer: Handle | null = null;

  constructor(
    private readonly draw: (call: ToolCall) => void,
    private readonly clock: Clock,
  ) {}

  event(event: LeaseEvent): void {
    switch (event.kind) {
      case 'waiting':
        this.open(
          `${WAITING} · ${event.ahead > 0 ? `${event.ahead} ahead` : 'next up'}`,
          true,
        );
        return;
      case 'step':
        this.open(MINT_STEPS[event.step], SLOW_STEPS.has(event.step));
        return;
      case 'connecting':
        this.open(CONNECTING, false);
        return;
      case 'ready':
        this.close(SANDBOX_READY, 'complete');
        return;
      case 'failed':
        this.show(oneLine(redact(`${MINT_FAILED}: ${event.error}`)), 'error');
        this.stop();
        return;
      case 'lost':
        this.show(SANDBOX_LOST, 'error');
        this.stop();
        return;
    }
  }

  /** At the turn's end: a card not yet drawn never will be. */
  end(): void {
    this.disarm();
  }

  private open(title: string, now: boolean): void {
    this.title = title;
    if (this.shown || now) {
      this.disarm();
      this.show(title, 'in_progress');
      return;
    }
    this.timer ??= this.clock.after(CARD_DELAY_MS, () => {
      this.timer = null;
      if (this.title) this.show(this.title, 'in_progress');
    });
  }

  private close(title: string, state: ToolCall['state']): void {
    if (this.shown) this.show(title, state);
    this.stop();
  }

  private show(title: string, state: ToolCall['state']): void {
    this.shown = state === 'in_progress';
    this.draw({ id: SANDBOX_CARD_ID, title, state });
  }

  private stop(): void {
    this.disarm();
    this.title = null;
    this.shown = false;
  }

  private disarm(): void {
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
  }
}

function spokenText(message: AgentMessage): string {
  if (!('role' in message) || message.role !== 'assistant') return '';
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

export class TurnTranslator {
  private readonly tools = new Map<string, ToolCall>();
  /** Titles of calls a resumed run made before the restart, by call id. */
  private readonly seeded = new Map<string, string>();
  private readonly card: SandboxCard;
  private readonly startedAt: number;
  private status: string | null = null;
  private thinking = false;
  private sawText = false;
  private retrying: string | null = null;
  /** Says why the fallback answers, until it streams text or calls a tool. */
  private routing: string | null = null;
  private readonly routes = new Set<Route>();
  /** Whether the assistant message now open has streamed any text. */
  private streamed = false;
  /** SIGTERM: the card is left as it was, so nothing more is drawn. */
  private stopped = false;
  firstTokenMs: number | null = null;
  costUsd = 0;

  constructor(
    private readonly sink: PromptSink,
    private readonly clock: Clock,
    private readonly metrics: Pick<Instruments, 'toolEnded'>,
  ) {
    this.startedAt = clock.now();
    this.card = new SandboxCard((call) => this.tool(call), clock);
  }

  /** Which models answered the turn's requests, or null before any. */
  get route(): Route | 'mixed' | null {
    if (this.routes.size > 1) return 'mixed';
    return [...this.routes][0] ?? null;
  }

  /** Some request of the turn went to the fallback. */
  get fellBack(): boolean {
    return this.routes.has('fallback');
  }

  /** A request of this turn's session was routed; sync and never throws. */
  routed(event: RouteEvent): void {
    this.routes.add(event.route);
    this.routing =
      event.route === 'fallback' && event.reason
        ? `↪️ ${event.model.id} is answering — ${REASONS[event.reason]}`
        : null;
    this.refresh();
  }

  get toolCount(): number {
    return [...this.tools.keys()].filter((id) => id !== SANDBOX_CARD_ID).length;
  }

  lease(event: LeaseEvent): void {
    this.card.event(event);
  }

  /**
   * A call made before a restart: pi's recovery can end it without starting
   * it again, and its end carries no arguments. Nothing is drawn until then.
   */
  seed(id: string, name: string, args: unknown): void {
    this.seeded.set(id, toolTitle(name, args));
  }

  /** Sync and never throws: pi awaits its listeners. */
  event(event: HarnessEvent): void {
    switch (event.type) {
      case 'message_start':
        if (isAssistant(event.message)) this.streamed = false;
        return;
      case 'message_update':
        this.update(event.event);
        return;
      case 'message_end':
        this.recovered(event.message);
        return;
      case 'tool_start':
        this.retrying = null;
        this.routing = null;
        this.tool({
          id: event.toolCallId,
          title: toolTitle(event.toolName, event.args),
          state: 'in_progress',
        });
        return;
      case 'tool_end': {
        const known = this.tools.get(event.toolCallId);
        this.metrics.toolEnded(event.toolName, event.isError);
        this.tool({
          id: event.toolCallId,
          title:
            known?.title ??
            this.seeded.get(event.toolCallId) ??
            toolTitle(event.toolName, undefined),
          state: event.isError ? 'error' : 'complete',
        });
        return;
      }
      case 'usage':
        this.costUsd += event.row.usage.cost.total;
        return;
      case 'retry_scheduled':
        this.retrying = `⏳ the model stumbled — retrying (${event.attempt}/${event.maxAttempts})`;
        this.refresh();
        return;
      case 'run_end':
        this.end();
        return;
      default:
        return;
    }
  }

  /** The turn is over: clears the status line and any card timer. */
  end(): void {
    this.card.end();
    this.retrying = null;
    this.routing = null;
    this.thinking = false;
    this.setStatus(null);
  }

  /** The turn was abandoned: nothing more reaches the card. */
  stop(): void {
    this.stopped = true;
    this.card.end();
  }

  private update(
    event: Extract<HarnessEvent, { type: 'message_update' }>['event'],
  ) {
    if (event.type === 'text_delta' && event.delta) {
      this.firstTokenMs ??= this.clock.now() - this.startedAt;
      this.sawText = true;
      this.streamed = true;
      this.retrying = null;
      this.routing = null;
      this.send({ kind: 'text', delta: event.delta });
      this.refresh();
    } else if (event.type === 'thinking_delta') {
      this.thinking = true;
      this.retrying = null;
      this.refresh();
    }
  }

  // A recovered message arrives whole, with no deltas; it is drawn once.
  private recovered(message: AgentMessage): void {
    if (!isAssistant(message)) return;
    const streamed = this.streamed;
    this.streamed = false;
    if (streamed) return;
    const text = spokenText(message);
    if (!text) return;
    this.firstTokenMs ??= this.clock.now() - this.startedAt;
    this.sawText = true;
    this.send({ kind: 'text', delta: text });
    this.refresh();
  }

  private tool(call: ToolCall): void {
    const known = this.tools.get(call.id);
    this.tools.set(call.id, call);
    if (known?.title !== call.title || known.state !== call.state) {
      this.send({ kind: 'tool', call });
    }
    this.refresh();
  }

  private refresh(): void {
    const running = [...this.tools.values()]
      .filter((tool) => tool.state === 'in_progress')
      .at(-1);
    this.setStatus(
      running
        ? `${running.title}…`
        : (this.retrying ??
            this.routing ??
            (this.thinking && !this.sawText ? THINKING : null)),
    );
  }

  private setStatus(line: string | null): void {
    if (line === this.status) return;
    this.status = line;
    this.send({ kind: 'status', line });
  }

  private send(update: Update): void {
    if (!this.stopped) this.sink.update(update);
  }
}

function isAssistant(message: AgentMessage): boolean {
  return 'role' in message && message.role === 'assistant';
}
