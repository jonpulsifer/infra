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
import { utc as at, type Clock, type Handle } from './clock.ts';
import type { CredentialChange } from './credential-store.ts';
import type { Log } from './log.ts';
import type { ChatgptSignIn, Instruments } from './metrics.ts';
import { CHATGPT, STORE_DOWN } from './notices.ts';
import {
  CHATGPT_PROVIDER,
  type ModelRouter,
  REASONS,
  type RouterStatus,
  refreshFailure,
  spec,
} from './route.ts';
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

export type SignIn =
  | { readonly state: 'unknown' }
  | { readonly state: 'none' }
  | { readonly state: 'good'; readonly expires: number }
  | {
      readonly state: 'refused';
      readonly expires: number;
      readonly at: number;
      /** OpenAI refused the refresh, or chatgpt.com a token fresh from one. */
      readonly by: 'refresh' | 'chatgpt';
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
  /** Told of every sign-in and refusal; asks for a rotation when chatgpt.com refuses the token. */
  readonly router?: Pick<
    ModelRouter,
    'credentialChanged' | 'authBroken' | 'onTokenRefused'
  > | null;
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
      options.router?.credentialChanged(change.stored);
    });
    options.router?.onTokenRefused((again) => {
      if (this.stopped) return;
      if (again) this.refusedByChatgpt();
      else void this.forceRefresh();
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
      this.options.router?.credentialChanged(false);
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
        this.set({ state: 'refused', expires, at: clock.now(), by: 'refresh' });
        this.options.router?.authBroken();
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

  /** A fresh token refused too: the account or mate's client is refused, and no rotation mends that. */
  private refusedByChatgpt(): void {
    const known = this.signIn;
    if (known.state !== 'good') return;
    const { clock, log } = this.options;
    this.set({
      state: 'refused',
      expires: known.expires,
      at: clock.now(),
      by: 'chatgpt',
    });
    log.error(
      'chatgpt.com refused a fresh ChatGPT token too; mate stays signed out until `chatgpt login`',
    );
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
/** A logout ended the sign-in, and says so itself. */
class SignInCancelled extends Error {}
/** mate is shutting down, and no process polls the code after it. */
class SignInInterrupted extends Error {}
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
  /** Settles once the sign-in has ended and a failure is said. */
  readonly ended: Promise<void>;
}

type Proof =
  | { readonly ok: true; readonly ms: number; readonly at: number }
  | { readonly ok: false; readonly why: string; readonly at: number };

export interface ChatgptAccountOptions {
  /** Straight to ChatGPT: the router must not send the test request elsewhere. */
  readonly models: Pick<Models, 'login' | 'logout' | 'completeSimple'>;
  readonly keeper: ChatgptKeeper;
  /** Read before a sign-in starts, since pi saves it only after the code is entered. */
  readonly credentials: Pick<WatchedCredentials, 'read'>;
  /** Where a sign-in's test request goes; null when pi lists no ChatGPT model. */
  readonly model: Model<Api> | null;
  /** What turns answer with: MATE_MODEL at MATE_THINKING. */
  readonly lane: {
    readonly model: Model<Api>;
    readonly thinking: ThinkingLevel;
  };
  /** Null while turns never use ChatGPT, so nothing routes or pauses. */
  readonly router: Pick<ModelRouter, 'pause' | 'resume' | 'status'> | null;
  readonly clock: Clock;
  readonly log: Log;
  readonly loginTimeoutMs?: number;
}

/** The `chatgpt` commands. Only the allowlist reaches them. */
export class ChatgptAccount implements Commands {
  private pending: Pending | null = null;
  private proof: Proof | null = null;

  constructor(private readonly options: ChatgptAccountOptions) {}

  parse(text: string): Command | null {
    const command = parseChatgptCommand(text);
    if (!command) return null;
    return { run: (context) => this.run(command, context) };
  }

  /** When a pause ends, or null while ChatGPT is not paused. */
  paused(): number | null {
    const now = this.options.router?.status().now;
    return now?.route === 'fallback' && now.reason === 'paused'
      ? now.retryAt
      : null;
  }

  /** On shutdown: ends a sign-in waiting for its code, once its thread is told. */
  async stop(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    pending.abort.abort(new SignInInterrupted());
    await pending.ended;
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
        return this.resume(context);
    }
  }

  private async login(context: CommandContext): Promise<void> {
    const { surface, thread, authorId } = context;
    const { clock, log, models } = this.options;
    try {
      await this.options.credentials.read(CHATGPT_PROVIDER);
    } catch {
      log.warn('no ChatGPT sign-in starts while mate-db cannot be read');
      await this.say(context, STORE_DOWN);
      return;
    }
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
    const ended = Promise.withResolvers<void>();
    const pending: Pending = {
      abort,
      until: clock.now() + DEVICE_CODE_SECONDS * 1000,
      ended: ended.promise,
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
      ended.resolve();
    }
    await told;
    log.info('mate is signed in to ChatGPT');
    await this.options.keeper.check();
    await this.say(context, this.signedIn(await this.prove()));
  }

  private async failed(context: CommandContext, reason: unknown) {
    if (reason instanceof SignInCancelled) return;
    if (reason instanceof SignInInterrupted) {
      this.options.log.info('mate stops waiting for the ChatGPT sign-in code');
      await this.say(
        context,
        `${CHATGPT.interrupted}. Say \`chatgpt login\` again for a new code.`,
      );
      return;
    }
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
    const tested = this.named(this.options.model);
    const lane = spec(this.options.lane.model);
    const fallback = this.fallback();
    if (!this.usesChatgpt()) {
      if (proof.ok) {
        return `${CHATGPT.signedIn}. A test request to ${tested} answered in ${seconds(proof.ms)}. MATE_MODEL is ${lane}, so turns do not use it yet.`;
      }
      return `${CHATGPT.proofFailed} a test request to ${tested} failed (${proof.why}). mate keeps answering with ${lane}; \`chatgpt status\` says more.`;
    }
    if (proof.ok) {
      return `${CHATGPT.signedIn}. A test request to ${tested} answered in ${seconds(proof.ms)}, so turns use it from now on${fallback ? `, with ${fallback} as the fallback` : ''}.`;
    }
    const meanwhile = fallback
      ? `mate answers with ${fallback} while ChatGPT fails`
      : 'mate has no fallback, so turns fail while ChatGPT does';
    return `${CHATGPT.proofFailed} a test request to ${tested} failed (${proof.why}). ${meanwhile}; \`chatgpt status\` says more.`;
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
    const answering = this.usesChatgpt()
      ? this.fallback()
      : spec(this.options.lane.model);
    const then = answering
      ? ` and answers with ${answering}`
      : ', and turns fail until the next sign-in';
    await this.say(
      context,
      `${CHATGPT.signedOut}${then}. Its last tokens stay valid at OpenAI until they expire; to end them now, sign out of all sessions in ChatGPT's security settings.`,
    );
  }

  private async pause(context: CommandContext, minutes: number) {
    const { clock, router } = this.options;
    const fallback = this.fallback();
    if (!router || !fallback) {
      await this.say(context, `${CHATGPT.status}${this.unrouted('pause')}`);
      return;
    }
    const now = clock.now();
    const until = now + minutes * MINUTE_MS;
    router.pause(until);
    await this.say(
      context,
      `${CHATGPT.paused} until ${at(until, now)}, or until mate restarts, and ${fallback} answers. Say \`chatgpt resume\` to end it sooner.`,
    );
  }

  private async resume(context: CommandContext) {
    const { router } = this.options;
    const fallback = this.fallback();
    if (!router || !fallback) {
      await this.say(context, `${CHATGPT.status}${this.unrouted('resume')}`);
      return;
    }
    router.resume();
    const now = router.status().now;
    await this.say(
      context,
      now.route === 'fallback' && now.retryAt === null
        ? `${CHATGPT.resumed}, but ${REASONS[now.reason]}, so ${fallback} answers until a sign-in.`
        : `${CHATGPT.resumed}, so the next request tries it.`,
    );
  }

  /** Why a pause or a resume has nothing to act on. */
  private unrouted(verb: 'pause' | 'resume'): string {
    return this.usesChatgpt()
      ? `MATE_FALLBACK_MODEL is none, so nothing answers in ChatGPT's place and there is nothing to ${verb}.`
      : `turns use ${spec(this.options.lane.model)}, not ChatGPT, so there is nothing to ${verb}.`;
  }

  private usesChatgpt(): boolean {
    return this.options.lane.model.provider === CHATGPT_PROVIDER;
  }

  /** What answers in ChatGPT's place, or null for nothing. */
  private fallback(): string | null {
    const fallback = this.options.router?.status().fallback;
    return fallback ? spec(fallback.model) : null;
  }

  private status(): string {
    const now = this.options.clock.now();
    const signIn = this.options.keeper.state();
    const { lane, router } = this.options;
    const lines = [`${CHATGPT.status}${signInLine(signIn, now)}`];
    if (router) {
      lines.push(...routeLines(router.status(), lane.thinking, now));
    } else {
      lines.push(
        `Turns use ${spec(lane.model)} (${lane.thinking}), not ChatGPT.`,
      );
    }
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

  private named(model: Model<Api> | null): string {
    return model ? spec(model) : CHATGPT_PROVIDER;
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
      return signIn.by === 'refresh'
        ? `signed out, because OpenAI refused the token refresh at ${at(signIn.at, now)}. Say \`chatgpt login\` to sign in again.`
        : `signed out, because chatgpt.com refused a fresh token too, at ${at(signIn.at, now)}. Say \`chatgpt login\` to sign in again.`;
  }
}

/** Which model answers now, and why, for `chatgpt status`. */
function routeLines(
  route: RouterStatus,
  thinking: ThinkingLevel,
  now: number,
): string[] {
  const primary = `${spec(route.primary)} (${thinking})`;
  const lines = [
    route.fallback
      ? `Route: ${primary}, fallback ${spec(route.fallback.model)} (${route.fallback.thinking}).`
      : `Route: ${primary}, with no fallback.`,
  ];
  const state = route.now;
  if (state.route === 'primary') {
    lines.push('Now: primary.');
  } else {
    const why = `${REASONS[state.reason]}${state.status === null ? '' : `, HTTP ${state.status}`}`;
    const since = `Now: fallback since ${at(state.since, now)} (${why})`;
    if (state.reason === 'paused' && state.retryAt !== null) {
      lines.push(`${since} until ${at(state.retryAt, now)}.`);
    } else if (state.retryAt === null) {
      lines.push(`${since}, until a sign-in.`);
    } else if (state.retryAt <= now) {
      lines.push(`${since}; the next request tries ChatGPT again.`);
    } else {
      lines.push(
        `${since}; trying ChatGPT again at ${at(state.retryAt, now)}.`,
      );
    }
  }
  lines.push(
    `Since start: ${route.requests.primary} requests on ChatGPT, ${route.requests.fallback} on the fallback.`,
  );
  return lines;
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
