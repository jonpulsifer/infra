/**
 * One ACP conversation with a harness on the far end of an exec stream:
 * initialize, open or load a session, run a turn with its updates folded
 * into the reply sink, cancel. Permission requests are answered allow —
 * the sandbox is the boundary, not the prompt.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { ExecClose, ExecStream } from './kube.ts';
import type { Log } from './log.ts';
import type { PromptResult, PromptSink } from './sandbox.ts';
import type { ToolCall, ToolState } from './surface.ts';

export const CLIENT_INFO = { name: 'mate', version: '0.1.0' };
export const THINKING = 'thinking…';
const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 90_000;
const CANCEL_GRACE_MS = 10_000;

export interface TurnSummary {
  stopReason: acp.StopReason;
  cost: acp.Cost | null;
  /** This turn's share of the session total above, when the baseline is known. */
  costUsd: number | null;
  tools: number;
  firstTextMs: number | null;
}

/**
 * ACP's own tool statuses as a surface reads them. `pending` is a call the
 * harness has announced and not started, which is indistinguishable from
 * running to anything mate paints — and Slack's card has no pending.
 */
function toolState(status: acp.ToolCallStatus | undefined): ToolState {
  if (status === 'completed') return 'complete';
  if (status === 'failed') return 'error';
  return 'in_progress';
}

/**
 * Folds a turn's `session/update` stream into the sink: the answer text, the
 * status line, and each tool call in its own right for a surface that renders
 * them. The two renderings of the same news go out together — which of them a
 * human sees is the canvas's to decide, not this.
 */
class Turn {
  private readonly tools = new Map<string, ToolCall>();
  private status: string | null = null;
  private thinking = false;
  private sawText = false;
  cost: acp.Cost | null = null;
  firstTextMs: number | null = null;
  cancelled = false;
  private readonly startedAt = performance.now();

  constructor(private readonly sink: PromptSink) {}

  get toolCount(): number {
    return this.tools.size;
  }

  update(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text' && update.content.text) {
          this.firstTextMs ??= Math.round(performance.now() - this.startedAt);
          this.sawText = true;
          this.sink.update({ kind: 'text', delta: update.content.text });
        }
        break;
      case 'agent_thought_chunk':
        this.thinking = true;
        break;
      case 'tool_call':
        this.tool({
          id: update.toolCallId,
          title: update.title,
          state: toolState(update.status),
        });
        break;
      case 'tool_call_update': {
        const known = this.tools.get(update.toolCallId);
        this.tool({
          id: update.toolCallId,
          title: update.title ?? known?.title ?? 'tool',
          // An update that names no status changes none: a completed call
          // does not start running again because its output arrived late.
          state: update.status
            ? toolState(update.status)
            : (known?.state ?? 'in_progress'),
        });
        break;
      }
      case 'usage_update':
        this.cost = update.cost ?? null;
        break;
      default:
        return;
    }
    this.refreshStatus();
  }

  /** One tool call, remembered and sent on only when it actually moved. */
  private tool(call: ToolCall): void {
    const known = this.tools.get(call.id);
    this.tools.set(call.id, call);
    if (known?.title === call.title && known.state === call.state) return;
    this.sink.update({ kind: 'tool', call });
  }

  private refreshStatus(): void {
    const running = [...this.tools.values()]
      .filter((t) => t.state === 'in_progress')
      .at(-1);
    const line = running
      ? `${running.title}…`
      : this.thinking && !this.sawText
        ? THINKING
        : null;
    if (line === this.status) return;
    this.status = line;
    this.sink.update({ kind: 'status', line });
  }
}

export class StreamClosed extends Error {
  override readonly name = 'StreamClosed';
  constructor(readonly close: ExecClose) {
    super(describeClose(close));
  }
}

function describeClose(close: ExecClose): string {
  const status = close.status;
  if (status?.status === 'Failure') {
    return `harness exited: ${status.message ?? status.reason ?? 'failure'}`;
  }
  return `exec stream closed (${close.code}${close.reason ? ` ${close.reason}` : ''})`;
}

export class AcpClient {
  private readonly conn: acp.ClientSideConnection;
  private turn: Turn | null = null;
  private closedNow: ExecClose | null = null;
  /**
   * ACP reports cost as the session's running total, so a turn's own cost is
   * the step. A loaded session starts with an unknown total — its first turn
   * reports no cost rather than the whole of someone else's session.
   */
  private sessionUsd: number | null = null;
  readonly closed: Promise<ExecClose>;

  constructor(
    private readonly exec: ExecStream,
    private readonly log: Log,
    private readonly fields: Record<string, unknown> = {},
  ) {
    this.conn = new acp.ClientSideConnection(
      () => this.client(),
      acp.ndJsonStream(exec.stdin, exec.stdout),
    );
    this.closed = exec.closed.then((close) => {
      this.closedNow = close;
      return close;
    });
  }

  get isClosed(): boolean {
    return this.closedNow !== null;
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return this.bounded(
      this.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: CLIENT_INFO,
      }),
      INITIALIZE_TIMEOUT_MS,
      'initialize',
    );
  }

  async newSession(cwd: string): Promise<string> {
    const response = await this.bounded(
      this.conn.newSession({ cwd, mcpServers: [] }),
      SESSION_TIMEOUT_MS,
      'session/new',
    );
    this.sessionUsd = 0;
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.bounded(
      this.conn.loadSession({ sessionId, cwd, mcpServers: [] }),
      SESSION_TIMEOUT_MS,
      'session/load',
    );
  }

  /**
   * Runs one turn. A harness-side failure is a result the thread can show;
   * the stream dying under the turn throws `StreamClosed`, which the thread
   * engine reads as a dead sandbox.
   */
  async prompt(
    sessionId: string,
    text: string,
    sink: PromptSink,
    timeoutMs: number,
  ): Promise<PromptResult & { summary?: TurnSummary }> {
    if (this.turn) throw new Error('a turn is already running');
    if (this.closedNow) throw new StreamClosed(this.closedNow);
    const turn = new Turn(sink);
    this.turn = turn;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const timedOut = new Promise<never>((_, reject) => {
      timers.push(
        setTimeout(() => {
          void this.cancel(sessionId);
          timers.push(
            setTimeout(
              () =>
                reject(new Error(`turn ran past ${timeoutMs / 60_000} min`)),
              CANCEL_GRACE_MS,
            ),
          );
        }, timeoutMs),
      );
    });
    try {
      const response = await Promise.race([
        this.conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
        this.closed.then((close) => {
          throw new StreamClosed(close);
        }),
        timedOut,
      ]);
      sink.update({ kind: 'status', line: null });
      const summary: TurnSummary = {
        stopReason: response.stopReason,
        cost: turn.cost,
        costUsd: this.spent(turn.cost),
        tools: turn.toolCount,
        firstTextMs: turn.firstTextMs,
      };
      this.log.info('turn ended', { ...this.fields, ...summary });
      return {
        ...outcome(response.stopReason),
        firstTokenMs: turn.firstTextMs,
        costUsd: summary.costUsd,
        summary,
      };
    } catch (error) {
      if (error instanceof StreamClosed) throw error;
      if (this.closedNow) throw new StreamClosed(this.closedNow);
      sink.update({ kind: 'status', line: null });
      return {
        stopReason: 'error',
        error: error instanceof Error ? error.message : String(error),
        firstTokenMs: turn.firstTextMs,
        costUsd: this.spent(turn.cost),
      };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      this.turn = null;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.turn) this.turn.cancelled = true;
    if (this.closedNow) return;
    await this.conn.cancel({ sessionId }).catch((error) => {
      this.log.warn('session/cancel failed', {
        ...this.fields,
        error: String(error),
      });
    });
  }

  close(): void {
    this.exec.close();
  }

  private spent(cost: acp.Cost | null): number | null {
    if (cost?.currency !== 'USD') return null;
    const before = this.sessionUsd;
    this.sessionUsd = cost.amount;
    return before === null ? null : cost.amount - before;
  }

  private async bounded<T>(
    request: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms,
      );
    });
    try {
      return await Promise.race([
        request,
        this.closed.then((close) => {
          throw new StreamClosed(close);
        }),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private client(): acp.Client {
    return {
      sessionUpdate: (params) => {
        this.turn?.update(params.update);
      },
      requestPermission: (params) => {
        if (this.turn?.cancelled) return { outcome: { outcome: 'cancelled' } };
        const pick =
          params.options.find((o) => o.kind === 'allow_always') ??
          params.options.find((o) => o.kind === 'allow_once') ??
          params.options[0];
        if (!pick) return { outcome: { outcome: 'cancelled' } };
        this.log.info('permission granted', {
          ...this.fields,
          title: params.toolCall.title ?? null,
          option: pick.optionId,
        });
        return { outcome: { outcome: 'selected', optionId: pick.optionId } };
      },
    };
  }
}

function outcome(stopReason: acp.StopReason): PromptResult {
  switch (stopReason) {
    case 'end_turn':
      return { stopReason: 'end_turn' };
    case 'cancelled':
      return { stopReason: 'cancelled' };
    default:
      return { stopReason: 'error', error: `harness stopped: ${stopReason}` };
  }
}
