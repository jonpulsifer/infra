/**
 * mate's ChatGPT sign-in: the owner's `chatgpt` commands, the device-code
 * login they start, and the keeper that refreshes the token outside turns.
 */
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AuthEvent,
  type AuthPrompt,
  type Model,
  type Models,
  ModelsError,
} from '@earendil-works/pi-ai';
import type { Clock, Handle } from './clock.ts';
import type { CredentialChange } from './credential-store.ts';
import type { Log } from './log.ts';
import type { ChatgptSignIn, Instruments } from './metrics.ts';
import { CHATGPT_PROVIDER } from './model.ts';
import { CHATGPT } from './notices.ts';
import type { Command, CommandContext, Commands } from './threads.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Tokens last ten days; the keeper rotates one with less than this left. */
export const REFRESH_MARGIN_MS = 2 * DAY_MS;
export const CHECK_MS = 6 * 3_600_000;
export const RETRY_MS = 15 * MINUTE_MS;
/** pi's device code lives 15 minutes; this bounds the whole sign-in. */
export const LOGIN_TIMEOUT_MS = 16 * MINUTE_MS;
export const PROOF_TIMEOUT_MS = 60_000;
export const PAUSE_DEFAULT_MINUTES = 60;
export const PAUSE_MAX_MINUTES = 7 * 24 * 60;
const DEVICE_CODE = 'device_code';
const DEVICE_CODE_SECONDS = 15 * 60;
export const PROOF_PROMPT = 'Reply with the single word pong.';

export type ChatgptCommand =
  | { readonly kind: 'login' | 'status' | 'logout' | 'resume' }
  | { readonly kind: 'pause'; readonly minutes: number };

const COMMAND =
  /^chatgpt (login|status|logout|resume|pause(?: (\d{1,5})m?)?)$/i;

/** The whole message, mention stripped, or null for a prompt. */
export function parseChatgptCommand(text: string): ChatgptCommand | null {
  const match = COMMAND.exec(text.trim().replace(/\s+/g, ' '));
  const verb = match?.[1]?.split(' ')[0]?.toLowerCase();
  if (!match || !verb) return null;
  if (verb === 'pause') {
    const asked = match[2] ? Number(match[2]) : PAUSE_DEFAULT_MINUTES;
    return {
      kind: 'pause',
      minutes: Math.min(Math.max(asked, 1), PAUSE_MAX_MINUTES),
    };
  }
  return { kind: verb as 'login' | 'status' | 'logout' | 'resume' };
}

/** A time the owner reads: the hour today, the date as well on another day. */
export function at(ms: number, now: number): string {
  const [day, time] = new Date(ms).toISOString().split('T');
  const today = new Date(now).toISOString().split('T')[0];
  const clock = time?.slice(0, 5) ?? '';
  return day === today ? `${clock} UTC` : `${day} ${clock} UTC`;
}

export type SignIn =
  | { readonly state: 'unknown' }
  | { readonly state: 'none' }
  | { readonly state: 'good'; readonly expires: number }
  | {
      readonly state: 'refused';
      readonly expires: number;
      readonly at: number;
    };

export type CheckResult =
  | 'none'
  | 'fresh'
  | 'refreshed'
  | 'refused'
  | 'transient'
  | 'store';

/** What the keeper reads the sign-in from; `CredentialChange` never carries a token. */
export interface WatchedCredentials {
  read(
    providerId: string,
  ): Promise<{ type: string; expires?: number } | undefined>;
  onChange(listener: (change: CredentialChange) => void): () => void;
}

export interface ChatgptKeeperOptions {
  readonly models: Pick<Models, 'getAuth'>;
  readonly credentials: WatchedCredentials;
  readonly clock: Clock;
  readonly log: Log;
  readonly metrics?: Pick<Instruments, 'chatgpt'>;
}

/**
 * Refreshes the token at boot and every six hours once under two days are
 * left, with no abort signal, so a Stop in a turn cannot cut off a rotation.
 */
export class ChatgptKeeper {
  private signIn: SignIn = { state: 'unknown' };
  private timer: Handle | null = null;
  private running: Promise<CheckResult> | null = null;
  private stopped = false;
  /** Credentials the store has written, which a rotation always adds to. */
  private writes = 0;

  constructor(private readonly options: ChatgptKeeperOptions) {
    options.credentials.onChange((change) => {
      if (change.providerId !== CHATGPT_PROVIDER) return;
      if (change.stored) this.writes += 1;
      this.set(
        change.stored && change.expires !== null
          ? { state: 'good', expires: change.expires }
          : { state: 'none' },
      );
    });
  }

  state(): SignIn {
    return this.signIn;
  }

  start(ready: Promise<void>): void {
    void ready.then(() => {
      if (!this.stopped) void this.check();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.options.clock.cancel(this.timer);
    this.timer = null;
  }

  check(): Promise<CheckResult> {
    this.running ??= this.run(false).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One rotation now, whatever is left: for a token the backend refuses. */
  async forceRefresh(): Promise<CheckResult> {
    // A check that has just rotated has replaced the refused token already.
    if ((await this.running) === 'refreshed') return 'refreshed';
    return this.run(true);
  }

  private async run(force: boolean): Promise<CheckResult> {
    const result = await this.attempt(force);
    this.schedule(
      result === 'transient' || result === 'store' ? RETRY_MS : CHECK_MS,
    );
    return result;
  }

  private async attempt(force: boolean): Promise<CheckResult> {
    const { credentials, models, clock, log } = this.options;
    let stored: { type: string; expires?: number } | undefined;
    try {
      stored = await credentials.read(CHATGPT_PROVIDER);
    } catch {
      log.warn('the ChatGPT sign-in could not be read; retrying');
      return 'store';
    }
    if (stored?.type !== 'oauth' || typeof stored.expires !== 'number') {
      this.set({ state: 'none' });
      return 'none';
    }
    const { expires } = stored;
    const known = this.signIn;
    // A refused refresh token stays refused; only a new sign-in replaces it.
    if (known.state === 'refused' && known.expires === expires) {
      return 'refused';
    }
    this.set({ state: 'good', expires });
    const left = expires - clock.now();
    if (!force && left >= REFRESH_MARGIN_MS) return 'fresh';
    const writes = this.writes;
    try {
      const auth = await models.getAuth(CHATGPT_PROVIDER, {
        minOAuthValidityMs: force
          ? Math.max(left, 0) + MINUTE_MS
          : REFRESH_MARGIN_MS,
      });
      if (!auth) return 'none';
    } catch (error) {
      // A forced rotation of a new token saves, then pi finds the next token
      // lasts no longer than the old one did and throws.
      if (this.writes !== writes && this.signIn.state === 'good') {
        return this.refreshed();
      }
      const failure = refreshFailure(error);
      if (failure.kind === 'refused') {
        this.set({ state: 'refused', expires, at: clock.now() });
        log.error(
          'OpenAI refused the ChatGPT refresh; mate stays signed out until `chatgpt login`',
          { status: failure.status },
        );
        return 'refused';
      }
      log.warn('the ChatGPT refresh failed; retrying', { why: failure.why });
      return failure.kind;
    }
    return this.refreshed();
  }

  private refreshed(): CheckResult {
    if (this.signIn.state === 'good') {
      this.options.log.info('the ChatGPT token is refreshed', {
        expiresAt: new Date(this.signIn.expires).toISOString(),
      });
    }
    return 'refreshed';
  }

  private schedule(ms: number): void {
    const { clock } = this.options;
    if (this.timer) clock.cancel(this.timer);
    this.timer = null;
    if (this.stopped) return;
    this.timer = clock.after(ms, () => {
      this.timer = null;
      void this.check();
    });
  }

  private set(signIn: SignIn): void {
    this.signIn = signIn;
    this.options.metrics?.chatgpt(gauge(signIn));
  }
}

function gauge(signIn: SignIn): ChatgptSignIn | null {
  switch (signIn.state) {
    case 'unknown':
      return null;
    case 'good':
      return { signedIn: true, expiresAt: signIn.expires };
    default:
      return { signedIn: false, expiresAt: null };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

type RefreshFailure =
  | { kind: 'refused'; status: number }
  | { kind: 'transient' | 'store'; why: string };

/**
 * pi rejects a refresh with a ModelsError whose cause names the HTTP status.
 * 400, 401 and 403 are a dead refresh token; anything else may pass.
 */
export function refreshFailure(error: unknown): RefreshFailure {
  if (error instanceof ModelsError && error.code === 'auth') {
    return { kind: 'store', why: 'mate-db' };
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const text = `${message(cause)} ${message(error)}`;
  const status = /token refresh failed \((\d{3})\)/.exec(text)?.[1];
  if (status && ['400', '401', '403'].includes(status)) {
    return { kind: 'refused', status: Number(status) };
  }
  if (status) return { kind: 'transient', why: `HTTP ${status}` };
  if (/timed? ?out|abort/i.test(text))
    return { kind: 'transient', why: 'timeout' };
  if (/token refresh error/i.test(text)) {
    return { kind: 'transient', why: 'network' };
  }
  return { kind: 'transient', why: 'unexpected' };
}

type LoginFailure =
  | { kind: 'expired' }
  | { kind: 'device-refused'; status: number }
  | { kind: 'failed'; why: string };

/** Fixed classes: pi's device and token errors can quote the whole token response. */
export function loginFailure(error: unknown): LoginFailure {
  if (error instanceof ModelsError && error.code === 'auth') {
    return {
      kind: 'failed',
      why: 'mate could not save it, because its memory is unreachable',
    };
  }
  const text = message(error);
  if (/device code login is not enabled/i.test(text)) {
    return { kind: 'device-refused', status: 404 };
  }
  const start = /device code request failed with status (\d{3})/i.exec(text);
  if (start) return { kind: 'device-refused', status: Number(start[1]) };
  if (/device flow timed out/i.test(text)) return { kind: 'expired' };
  if (/device auth failed with status/i.test(text)) {
    return { kind: 'failed', why: 'OpenAI refused the code' };
  }
  const exchange = /token exchange failed \((\d{3})\)/i.exec(text)?.[1];
  if (exchange) {
    return {
      kind: 'failed',
      why: `the token exchange failed (HTTP ${exchange})`,
    };
  }
  if (/accountId|missing fields|Invalid OpenAI Codex device/i.test(text)) {
    return {
      kind: 'failed',
      why: 'OpenAI answered with a token mate cannot use',
    };
  }
  if (/timed? ?out/i.test(text)) return { kind: 'failed', why: 'it timed out' };
  if (
    error instanceof TypeError ||
    /fetch|connect|socket|network|ECONN|ENOTFOUND/i.test(text)
  ) {
    return { kind: 'failed', why: 'auth.openai.com could not be reached' };
  }
  return { kind: 'failed', why: 'an unexpected error' };
}

class SignInExpired extends Error {}
class SignInCancelled extends Error {}
class NotWhispered extends Error {}

/** A surface error's class and code, which name the refusal without quoting the request. */
function refusal(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: 'unknown' };
  const code = (error as { code?: unknown }).code;
  return {
    error: error.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}

interface Pending {
  readonly abort: AbortController;
  until: number;
}

type Proof =
  | { readonly ok: true; readonly ms: number; readonly at: number }
  | { readonly ok: false; readonly why: string; readonly at: number };

export interface ChatgptAccountOptions {
  readonly models: Pick<Models, 'login' | 'logout' | 'completeSimple'>;
  readonly keeper: ChatgptKeeper;
  /** Where a sign-in's test request goes; null when pi lists no ChatGPT model. */
  readonly model: Model<Api> | null;
  /** What turns answer with: MATE_MODEL at MATE_THINKING. */
  readonly lane: {
    readonly model: Model<Api>;
    readonly thinking: ThinkingLevel;
  };
  readonly clock: Clock;
  readonly log: Log;
  readonly loginTimeoutMs?: number;
}

/** The `chatgpt` commands. Only the allowlist reaches them. */
export class ChatgptAccount implements Commands {
  private pending: Pending | null = null;
  private pausedUntil: number | null = null;
  private proof: Proof | null = null;

  constructor(private readonly options: ChatgptAccountOptions) {}

  parse(text: string): Command | null {
    const command = parseChatgptCommand(text);
    if (!command) return null;
    return { run: (context) => this.run(command, context) };
  }

  /** When a pause ends, or null while ChatGPT is not paused. */
  paused(): number | null {
    if (
      this.pausedUntil !== null &&
      this.pausedUntil <= this.options.clock.now()
    ) {
      this.pausedUntil = null;
    }
    return this.pausedUntil;
  }

  /** Ends a sign-in that is waiting for its code, on shutdown. */
  stop(): void {
    this.pending?.abort.abort(new SignInCancelled());
  }

  private async run(
    command: ChatgptCommand,
    context: CommandContext,
  ): Promise<void> {
    switch (command.kind) {
      case 'login':
        return this.login(context);
      case 'status':
        return this.say(context, this.status());
      case 'logout':
        return this.logout(context);
      case 'pause':
        return this.pause(context, command.minutes);
      case 'resume':
        this.pausedUntil = null;
        return this.say(context, `${CHATGPT.resumed}.`);
    }
  }

  private async login(context: CommandContext): Promise<void> {
    const { surface, thread, authorId } = context;
    const { clock, log, models } = this.options;
    if (this.pending) {
      await this.say(
        context,
        `${CHATGPT.codeWaiting}, until ${at(this.pending.until, clock.now())}.`,
      );
      return;
    }
    const whisper = surface.whisper?.bind(surface);
    if (!whisper) {
      await this.say(
        context,
        `${CHATGPT.noWhisper}, so it did not start a sign-in.`,
      );
      return;
    }
    const abort = new AbortController();
    const pending: Pending = {
      abort,
      until: clock.now() + DEVICE_CODE_SECONDS * 1000,
    };
    this.pending = pending;
    const timeout = clock.after(
      this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
      () => abort.abort(new SignInExpired()),
    );
    let told: Promise<void> = Promise.resolve();
    const notify = (event: AuthEvent) => {
      if (event.type !== 'device_code') return;
      const now = clock.now();
      const seconds = event.expiresInSeconds ?? DEVICE_CODE_SECONDS;
      pending.until = now + seconds * 1000;
      const code = `Sign mate in to ChatGPT: open ${event.verificationUri} while signed in to your own ChatGPT account, and enter ${event.userCode}. The code expires at ${at(pending.until, now)}.`;
      told = whisper(thread, authorId, code).then(
        () =>
          this.say(
            context,
            `${CHATGPT.codeSent}${surface.name === 'discord' ? ' by DM' : ' that only you can see, in this channel'}. It works for ${Math.round(seconds / 60)} minutes.`,
          ),
        (error) => {
          abort.abort(new NotWhispered(undefined, { cause: error }));
        },
      );
    };
    const prompt = async (asked: AuthPrompt): Promise<string> => {
      if (
        asked.type === 'select' &&
        asked.options.some((option) => option.id === DEVICE_CODE)
      ) {
        return DEVICE_CODE;
      }
      throw new Error(`mate answers no ${asked.type} prompt`);
    };
    try {
      await models.login(CHATGPT_PROVIDER, 'oauth', {
        signal: abort.signal,
        prompt,
        notify,
      });
    } catch (error) {
      await told;
      await this.failed(context, abort.signal.reason ?? error);
      return;
    } finally {
      clock.cancel(timeout);
      this.pending = null;
    }
    await told;
    log.info('mate is signed in to ChatGPT');
    await this.options.keeper.check();
    await this.say(context, this.signedIn(await this.prove()));
  }

  private async failed(context: CommandContext, reason: unknown) {
    if (reason instanceof SignInCancelled) return;
    const discord = context.surface.name === 'discord';
    if (reason instanceof NotWhispered) {
      this.options.log.warn(
        'the ChatGPT sign-in code could not be sent privately',
        refusal(reason.cause),
      );
      await this.say(
        context,
        discord
          ? `${CHATGPT.notSent} by DM, so mate cancelled the sign-in. Allow direct messages from members of this server, then say \`chatgpt login\` again.`
          : `${CHATGPT.notSent} privately, so mate cancelled the sign-in. Say \`chatgpt login\` again.`,
      );
      return;
    }
    const failure: LoginFailure =
      reason instanceof SignInExpired
        ? { kind: 'expired' }
        : loginFailure(reason);
    this.options.log.warn('the ChatGPT sign-in failed', {
      why: failure.kind === 'failed' ? failure.why : failure.kind,
    });
    switch (failure.kind) {
      case 'expired':
        await this.say(
          context,
          `${CHATGPT.codeExpired}. Say \`chatgpt login\` for a new one.`,
        );
        return;
      case 'device-refused':
        await this.say(
          context,
          `${CHATGPT.deviceRefused} (HTTP ${failure.status}), which it does when device sign-in is off for the account.`,
        );
        return;
      case 'failed':
        await this.say(context, `${CHATGPT.failed}: ${failure.why}.`);
    }
  }

  /** One request over SSE, which proves egress to chatgpt.com and the plan. */
  private async prove(): Promise<Proof> {
    const { clock, log, model, models } = this.options;
    const startedAt = clock.now();
    if (!model)
      return { ok: false, why: 'pi lists no ChatGPT model', at: startedAt };
    const seen: { status: number | null } = { status: null };
    let why: string;
    try {
      const answer = await models.completeSimple(
        model,
        {
          messages: [
            { role: 'user', content: PROOF_PROMPT, timestamp: Date.now() },
          ],
        },
        {
          reasoning: 'low',
          transport: 'sse',
          timeoutMs: PROOF_TIMEOUT_MS,
          signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
          onResponse: (response) => {
            seen.status = response.status;
          },
        },
      );
      if (answer.stopReason !== 'error' && answer.stopReason !== 'aborted') {
        this.proof = { ok: true, ms: clock.now() - startedAt, at: clock.now() };
        return this.proof;
      }
      why = proofFailure(
        answer.stopReason,
        answer.errorMessage ?? '',
        seen.status,
      );
    } catch (error) {
      why = proofFailure('error', message(error), seen.status);
    }
    log.warn('the ChatGPT test request failed', { why });
    this.proof = { ok: false, why, at: clock.now() };
    return this.proof;
  }

  private signedIn(proof: Proof): string {
    const spec = this.spec(this.options.model);
    const lane = this.spec(this.options.lane.model);
    if (proof.ok) {
      return `${CHATGPT.signedIn}. A test request to ${spec} answered in ${seconds(proof.ms)}. MATE_MODEL is ${lane}, so turns do not use it yet.`;
    }
    return `${CHATGPT.proofFailed} a test request to ${spec} failed (${proof.why}). mate keeps answering with ${lane}; \`chatgpt status\` says more.`;
  }

  private async logout(context: CommandContext): Promise<void> {
    this.pending?.abort.abort(new SignInCancelled());
    try {
      await this.options.models.logout(CHATGPT_PROVIDER);
    } catch {
      await this.say(
        context,
        `${CHATGPT.logoutFailed}, because its memory is unreachable. Say \`chatgpt logout\` again in a minute.`,
      );
      return;
    }
    this.proof = null;
    this.options.log.info('mate signed out of ChatGPT');
    await this.say(
      context,
      `${CHATGPT.signedOut} and answers with ${this.spec(this.options.lane.model)}. Its last tokens stay valid at OpenAI until they expire; to end them now, sign out of all sessions in ChatGPT's security settings.`,
    );
  }

  private async pause(context: CommandContext, minutes: number) {
    const now = this.options.clock.now();
    this.pausedUntil = now + minutes * MINUTE_MS;
    await this.say(
      context,
      `${CHATGPT.paused} until ${at(this.pausedUntil, now)}, or until mate restarts. Say \`chatgpt resume\` to end it sooner.`,
    );
  }

  private status(): string {
    const now = this.options.clock.now();
    const signIn = this.options.keeper.state();
    const { lane } = this.options;
    const lines = [`${CHATGPT.status}${signInLine(signIn, now)}`];
    lines.push(
      `Turns use ${this.spec(lane.model)} (${lane.thinking}), not ChatGPT.`,
    );
    const paused = this.paused();
    if (paused !== null) lines.push(`Paused until ${at(paused, now)}.`);
    if (this.pending) {
      lines.push(
        `A sign-in is waiting for its code, until ${at(this.pending.until, now)}.`,
      );
    }
    if (this.proof) {
      lines.push(
        this.proof.ok
          ? `The last test request answered in ${seconds(this.proof.ms)}, at ${at(this.proof.at, now)}.`
          : `The last test request failed (${this.proof.why}), at ${at(this.proof.at, now)}.`,
      );
    }
    return lines.join(' ');
  }

  private spec(model: Model<Api> | null): string {
    return model ? `${model.provider}/${model.id}` : `${CHATGPT_PROVIDER}`;
  }

  private async say(context: CommandContext, text: string): Promise<void> {
    await context.surface.post(context.thread, text).catch((error) =>
      this.options.log.warn('a chatgpt reply failed', {
        threadId: context.thread.id,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }
}

function signInLine(signIn: SignIn, now: number): string {
  switch (signIn.state) {
    case 'unknown':
      return 'unknown, because mate has not read its memory yet or cannot reach it.';
    case 'none':
      return 'not signed in. Say `chatgpt login` to sign in.';
    case 'good':
      return signIn.expires > now
        ? `signed in, token good until ${at(signIn.expires, now)}.`
        : `signed in, but its token expired at ${at(signIn.expires, now)} and mate has not refreshed it.`;
    case 'refused':
      return `signed out, because OpenAI refused the token refresh at ${at(signIn.at, now)}. Say \`chatgpt login\` to sign in again.`;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function proofFailure(
  stopReason: string,
  text: string,
  status: number | null,
): string {
  if (stopReason === 'aborted' || /timed? ?out|abort/i.test(text)) {
    return 'it timed out';
  }
  if (status === 429 || /usage limit/i.test(text)) {
    return "ChatGPT's usage limit is reached";
  }
  if (status !== null && status >= 400) return `HTTP ${status}`;
  if (/not configured/i.test(text)) return 'mate holds no sign-in';
  if (
    status === null &&
    /fetch|connect|socket|network|ECONN|ENOTFOUND/i.test(text)
  ) {
    return 'chatgpt.com could not be reached';
  }
  return 'an unexpected error';
}
