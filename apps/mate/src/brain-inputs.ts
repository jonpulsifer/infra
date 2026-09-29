/**
 * What the brain is built from, each made once per process: the model and its
 * key, the system prompt, and the kthx tools bridged from MCP.
 */
import type {
  AgentHarnessTool,
  ExecutionToolContext,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { Clock } from './clock.ts';
import type { Log } from './log.ts';
import type { SurfaceName } from './surface.ts';

export interface ModelSetupOptions {
  /** `provider/model`, from MATE_MODEL. */
  readonly spec: string;
  readonly thinking: ThinkingLevel;
  /** Read on every request, so a rotated key needs no restart. */
  readonly keyFile: string;
  readonly log: Log;
}

export interface ModelSetup {
  readonly models: Models;
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel;
}

/**
 * Throws `ConfigError` for a provider mate does not register, a model the
 * catalog lacks, or a thinking level outside pi-ai's
 * `getSupportedThinkingLevels(model)`.
 */
export type CreateModelSetup = (options: ModelSetupOptions) => ModelSetup;

export interface ProfileOptions {
  /** Holds AGENTS.md, dotfiles/skills and .agents/skills: the repo root, or /app in the image. */
  readonly root: string;
  /** Where each sandbox checks the repo out; skill locations point here. */
  readonly workspace: string;
  readonly checkoutRef: string;
  readonly log: Log;
}

export type SystemPrompts = Readonly<Record<SurfaceName, string>>;

/** Never rejects: a missing file is logged and left out, so mate still boots. */
export type LoadSystemPrompts = (
  options: ProfileOptions,
) => Promise<SystemPrompts>;

export type BridgedTool = AgentHarnessTool<ExecutionToolContext>;

/** Every bridged tool's name starts with this. */
export const KTHX_TOOL_PREFIX = 'kthx_';

export interface McpInstruments {
  mcpUp(up: boolean): void;
  mcpCall(result: 'ok' | 'error' | 'unavailable' | 'aborted'): void;
}

export interface McpBridgeOptions {
  readonly url: string;
  readonly token: string;
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

export type CreateKthxMcp = (options: McpBridgeOptions) => McpBridge;
