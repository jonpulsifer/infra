/**
 * What the brain is built from, each made once per process: the model and its
 * key, the system prompt of each profile, and the tools bridged from MCP
 * servers.
 */
import type {
  Api,
  CredentialStore,
  Model,
  Models,
  Provider,
  ModelThinkingLevel as ThinkingLevel,
} from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { Clock } from './clock.ts';
import type { Log } from './log.ts';
import type { Instruments } from './metrics.ts';
import type { Profile } from './profiles.ts';
import type { ModelRouter } from './route.ts';
import type { SurfaceName } from './surface.ts';

export interface ModelSetupOptions {
  /** `provider/model`, from MATE_MODEL. */
  readonly spec: string;
  readonly thinking: ThinkingLevel;
  /** `provider/model`, from MATE_FALLBACK_MODEL; null or absent routes nothing. */
  readonly fallbackSpec?: string | null;
  /** From MATE_FALLBACK_THINKING; null takes the fallback's level nearest `thinking`. */
  readonly fallbackThinking?: ThinkingLevel | null;
  /** Read on every request, so a rotated key needs no restart. */
  readonly keyFile: string;
  /** Holds the ChatGPT sign-in; without one, pi keeps it in memory. */
  readonly credentials?: CredentialStore;
  /** What a spec may name; OpenCode Go's and ChatGPT's when absent. */
  readonly providers?: readonly Provider[];
  readonly log: Log;
  readonly clock?: Clock;
  readonly metrics?: Pick<
    Instruments,
    'modelRouted' | 'primaryFailed' | 'primaryUp'
  >;
}

export interface ModelSetup {
  /** What turns ask: ChatGPT first and the fallback after, when routed. */
  readonly models: Models;
  /** Straight to each provider: a sign-in's test request must reach ChatGPT itself. */
  readonly direct: Models;
  /** The lane's model, MATE_MODEL. */
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel;
  /** Null when nothing routes: no fallback, and a primary other than ChatGPT. */
  readonly router: ModelRouter | null;
}

export interface ProfileOptions {
  /** Holds the persona, dotfiles/.agents/AGENTS.md, AGENTS.md, dotfiles/skills and .agents/skills: the repo root, or /app in the image. */
  readonly root: string;
  /** Where each sandbox checks the repo out; skill locations point here. */
  readonly workspace: string;
  readonly checkoutRef: string;
  readonly log: Log;
}

export type SystemPrompts = Readonly<Record<SurfaceName, string>>;

/** By profile id, then surface. */
export type ProfilePrompts = Readonly<Record<string, SystemPrompts>>;

/** A profile as the brain runs it, resolved at boot so nothing in it fails at a turn. */
export interface BrainProfile {
  readonly profile: Profile;
  readonly prompts: SystemPrompts;
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel;
  readonly turnTimeoutMs: number;
}

export type BridgedTool = ToolRegistration;

/** Every tool bridged from the kthx server starts with this. */
export const KTHX_TOOL_PREFIX = 'kthx_';

export interface McpInstruments {
  mcpUp(server: string, up: boolean): void;
  mcpCall(
    server: string,
    result: 'ok' | 'error' | 'unavailable' | 'aborted',
  ): void;
}

export interface McpBridgeOptions {
  /** Names the server in logs, labels and errors, such as `kthx`. */
  readonly name: string;
  /** Starts every bridged tool's name, such as `kthx_`. */
  readonly prefix: string;
  readonly url: string;
  /** Sent as a bearer; a server without one gets no Authorization header. */
  readonly token?: string;
  readonly log: Log;
  readonly clock?: Clock;
  readonly metrics?: McpInstruments;
}

export interface McpBridge {
  /**
   * Every tool listed so far, under unique names; one stays while the server
   * is down, and answers an error.
   */
  tools(): readonly BridgedTool[];
  /** Called when `tools()` gains or replaces a tool. */
  onChange(listener: () => void): () => void;
  /** Connects in the background and retries until the first listing succeeds. */
  start(): void;
  /** True once a listing has succeeded, or false after `timeoutMs`. */
  ready(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}
