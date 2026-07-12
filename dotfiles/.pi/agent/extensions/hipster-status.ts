import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { basename } from "node:path";

const SPARKLE_FRAMES = ["✨", "🌙", "🪩", "🫧", "🌿", "⚡"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const WORKING_PHRASES = [
	"reticulating splines",
	"removing pool ladder",
	"constructing additional pylons",
	"rolling for initiative",
	"checking another castle",
	"saving Hyrule in a side quest",
	"mining one more block",
	"pressing F to ponder",
	"warping through Green Hill",
	"summoning the chocobo",
	"waiting for the cake to compile",
	"catching a missingno thought",
] as const;

const GIT_CACHE_TTL_MS = 1_000;
const GIT_TIMEOUT_MS = 350;
const CONTEXT_WARNING_PCT = 70;
const CONTEXT_ERROR_PCT = 90;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ThemeColor = Parameters<Theme["fg"]>[0];
type SemanticColor = ThemeColor | "thinkingHigh" | "thinkingXhigh" | "mdHeading";
type FooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
};
type ContextUsage = { tokens: number; contextWindow?: number; percent?: number };

type Segment = {
	id: string;
	order: number;
	priority: number;
	semantic: SemanticColor;
	content: string;
	width: number;
};

type GitStatus = {
	branch: string | null;
	staged: number;
	unstaged: number;
	untracked: number;
};

let gitCache: { cwd: string; status: GitStatus; timestamp: number } | undefined;
let gitPending: Promise<GitStatus | null> | undefined;
let gitGeneration = 0;

function hasPowerlineGlyphs(): boolean {
	if (process.env.POWERLINE_NERD_FONTS === "1") return true;
	if (process.env.POWERLINE_NERD_FONTS === "0") return false;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const term = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`.toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((name) => term.includes(name));
}

function separatorText(kind: "hard" | "thin" = "thin"): string {
	if (!hasPowerlineGlyphs()) return kind === "hard" ? ">" : "|";
	return kind === "hard" ? "\uE0B0" : "\uE0B1";
}

function color(theme: Theme, semantic: SemanticColor, text: string): string {
	return theme.fg(semantic as ThemeColor, text);
}

function shortModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "no-model";
	return `${model.provider}/${model.id}`
		.replace(/^openai-codex\//, "codex/")
		.replace(/^anthropic\//, "claude/")
		.replace(/^google\//, "gemini/")
		.replace(/claude-(sonnet|opus)-/, "$1-")
		.replace(/gpt-/, "gpt");
}

function fmtTokens(n: number): string {
	if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function branchStats(ctx: ExtensionContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	messages: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let messages = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		messages++;
		if (entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cacheRead += message.usage?.cacheRead ?? 0;
		cacheWrite += message.usage?.cacheWrite ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}

	return { input, output, cacheRead, cacheWrite, cost, messages };
}

function sessionLabel(pi: ExtensionAPI, ctx: ExtensionContext): string {
	return pi.getSessionName() ?? basename(ctx.cwd) ?? "untitled";
}

function workingFrames(ctx: ExtensionContext): string[] {
	return WORKING_PHRASES.map((phrase, index) => {
		const sparkle = ctx.ui.theme.fg("accent", SPARKLE_FRAMES[index % SPARKLE_FRAMES.length]!);
		return `${sparkle} ${ctx.ui.theme.fg("muted", phrase)}`;
	});
}

function setThinking(pi: ExtensionAPI, ctx: ExtensionContext, level: ThinkingLevel): void {
	const before = pi.getThinkingLevel();
	pi.setThinkingLevel(level);
	const after = pi.getThinkingLevel();
	const suffix = after === level ? "" : ctx.ui.theme.fg("dim", ` (clamped from ${level})`);
	ctx.ui.notify(`🧠 thinking: ${before} → ${after}${suffix}`, "info");
}

function cycleThinking(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): void {
	const current = pi.getThinkingLevel();
	const index = THINKING_LEVELS.indexOf(current as ThinkingLevel);
	const next = THINKING_LEVELS[(Math.max(0, index) + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length]!;
	setThinking(pi, ctx, next);
}

function parseGitStatus(output: string): GitStatus {
	let branch: string | null = null;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;

	for (const line of output.split("\n")) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const raw = line.slice(3).split("...")[0]?.replace(/^HEAD \(no branch\)$/, "detached").trim();
			branch = raw && !raw.startsWith("No commits yet on ") ? raw : raw?.replace("No commits yet on ", "") || null;
			continue;
		}

		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked++;
			continue;
		}
		if (x && x !== " " && x !== "?") staged++;
		if (y && y !== " ") unstaged++;
	}

	return { branch, staged, unstaged, untracked };
}

function fetchGitStatus(cwd: string): Promise<GitStatus | null> {
	return new Promise((resolve) => {
		const proc = spawn("git", ["status", "--short", "--branch", "--untracked-files=normal"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		let resolved = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: GitStatus | null) => {
			if (resolved) return;
			resolved = true;
			if (timeout) clearTimeout(timeout);
			resolve(status);
		};

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.on("close", (code) => finish(code === 0 ? parseGitStatus(stdout.trim()) : null));
		proc.on("error", () => finish(null));
		timeout = setTimeout(() => {
			proc.kill();
			finish(null);
		}, GIT_TIMEOUT_MS);
	});
}

function getGitStatus(cwd: string, providerBranch: string | null, onUpdate: () => void): GitStatus {
	const now = Date.now();
	if (gitCache?.cwd === cwd && now - gitCache.timestamp < GIT_CACHE_TTL_MS) {
		return gitCache.status;
	}

	if (!gitPending) {
		const generation = gitGeneration;
		gitPending = fetchGitStatus(cwd)
			.then((status) => {
				if (generation === gitGeneration) {
					gitCache = {
						cwd,
						status: status ?? { branch: providerBranch, staged: 0, unstaged: 0, untracked: 0 },
						timestamp: Date.now(),
					};
					onUpdate();
				}
				return status;
			})
			.finally(() => {
				gitPending = undefined;
			});
	}

	return gitCache?.cwd === cwd ? gitCache.status : { branch: providerBranch, staged: 0, unstaged: 0, untracked: 0 };
}

function invalidateGitStatus(): void {
	gitCache = undefined;
	gitGeneration++;
}

function addSegment(
	segments: Segment[],
	theme: Theme,
	id: string,
	order: number,
	priority: number,
	semantic: SemanticColor,
	label: string,
	maxWidth = 32,
): void {
	const fitted = truncateToWidth(label, maxWidth, "…");
	const content = color(theme, semantic, fitted);
	const width = visibleWidth(content);
	if (width > 0) segments.push({ id, order, priority, semantic, content, width });
}

function contextSegment(ctx: ExtensionContext): { label: string; semantic: SemanticColor } | null {
	const usage = ctx.getContextUsage() as ContextUsage | undefined;
	if (!usage) return { label: "ctx fresh", semantic: "dim" };

	const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage.percent ?? (contextWindow > 0 ? (usage.tokens / contextWindow) * 100 : null);
	const percentText = percent === null ? "" : ` ${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
	const semantic: SemanticColor =
		percent !== null && percent >= CONTEXT_ERROR_PCT
			? "error"
			: percent !== null && percent >= CONTEXT_WARNING_PCT
				? "warning"
				: "dim";
	return { label: `ctx ${fmtTokens(usage.tokens)}${percentText}`, semantic };
}

function collectSegments(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	footerData: FooterData | undefined,
	onUpdate: () => void,
): Segment[] {
	const segments: Segment[] = [];
	const stats = branchStats(ctx);
	const thinking = pi.getThinkingLevel() as ThinkingLevel;
	const thinkingColors: Record<ThinkingLevel, SemanticColor> = {
		off: "thinkingOff",
		minimal: "thinkingMinimal",
		low: "thinkingLow",
		medium: "thinkingMedium",
		high: "thinkingHigh",
		xhigh: "thinkingXhigh",
	};

	addSegment(segments, theme, "model", 10, 100, "accent", `🤖 ${shortModel(ctx)}`, 30);
	addSegment(segments, theme, "thinking", 20, 90, thinkingColors[thinking] ?? "thinkingMedium", `think:${thinking}`, 14);
	addSegment(segments, theme, "path", 30, 80, "mdHeading", `📁 ${basename(ctx.cwd) || "~"}`, 24);

	const providerBranch = footerData?.getGitBranch?.() ?? null;
	const git = getGitStatus(ctx.cwd, providerBranch, onUpdate);
	if (git.branch) {
		const dirty = git.staged + git.unstaged + git.untracked > 0;
		const parts = [`🌱 ${git.branch}`];
		if (git.staged > 0) parts.push(`+${git.staged}`);
		if (git.unstaged > 0) parts.push(`*${git.unstaged}`);
		if (git.untracked > 0) parts.push(`?${git.untracked}`);
		addSegment(segments, theme, "git", 40, 75, dirty ? "warning" : "success", parts.join(" "), 30);
	}

	const context = contextSegment(ctx);
	if (context) addSegment(segments, theme, "context", 50, 70, context.semantic, `🪟 ${context.label}`, 22);

	const totalTokens = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
	if (totalTokens > 0) addSegment(segments, theme, "tokens", 60, 55, "muted", `⊛ ${fmtTokens(totalTokens)}`, 14);
	if (stats.cost > 0) addSegment(segments, theme, "cost", 70, 45, "text", `$${stats.cost.toFixed(3)}`, 12);
	if (stats.messages > 0) addSegment(segments, theme, "messages", 80, 35, "dim", `msg ${stats.messages}`, 10);
	addSegment(segments, theme, "session", 90, 30, "dim", `🛸 ${sessionLabel(pi, ctx)}`, 24);

	const statuses = footerData?.getExtensionStatuses?.();
	const compactStatuses = statuses
		? [...statuses.entries()]
				.filter(([key, value]) => key !== "hipster-status" && visibleWidth(value) > 0 && !value.startsWith("["))
				.map(([key, value]) => `${key}:${value}`)
		: [];
	if (compactStatuses.length > 0) {
		addSegment(segments, theme, "extension-statuses", 100, 20, "muted", compactStatuses.join(" · "), 36);
	}

	return segments;
}

function rowWidth(segments: Segment[], separatorWidth: number): number {
	if (segments.length === 0) return 0;
	return 2 + segments.reduce((sum, segment) => sum + segment.width, 0) + separatorWidth * (segments.length - 1);
}

function packSegments(segments: Segment[], width: number, separatorWidth: number): { fit: Segment[]; overflow: Segment[] } {
	const fit: Segment[] = [];
	for (const segment of [...segments].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
		const candidate = [...fit, segment].sort((a, b) => a.order - b.order);
		if (rowWidth(candidate, separatorWidth) <= width) fit.push(segment);
	}

	const fitIds = new Set(fit.map((segment) => segment.id));
	return {
		fit: fit.sort((a, b) => a.order - b.order),
		overflow: segments.filter((segment) => !fitIds.has(segment.id)).sort((a, b) => a.order - b.order),
	};
}

function buildPowerlineRow(segments: Segment[], width: number, theme: Theme, kind: "hard" | "thin"): string | null {
	if (width <= 0 || segments.length === 0) return null;
	const separator = color(theme, "dim", ` ${separatorText(kind)} `);
	const line = ` ${segments.map((segment) => segment.content).join(separator)} `;
	return truncateToWidth(line, width, "");
}

function renderRows(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	footerData: FooterData | undefined,
	width: number,
	onUpdate: () => void,
): { top: string[]; secondary: string[] } {
	if (width < 8) return { top: [], secondary: [] };
	const segments = collectSegments(pi, ctx, theme, footerData, onUpdate);
	if (segments.length === 0) return { top: [], secondary: [] };

	const separatorWidth = visibleWidth(` ${separatorText("thin")} `);
	let topPacked = packSegments(segments, width, separatorWidth);
	if (topPacked.fit.length === 0) {
		const first = [...segments].sort((a, b) => b.priority - a.priority)[0]!;
		topPacked = { fit: [first], overflow: segments.filter((segment) => segment.id !== first.id) };
	}

	const secondaryPacked = packSegments(topPacked.overflow, width, separatorWidth);
	const topLine = buildPowerlineRow(topPacked.fit, width, theme, "hard");
	const secondaryLine = buildPowerlineRow(secondaryPacked.fit, width, theme, "thin");

	return {
		top: topLine ? [topLine] : [],
		secondary: secondaryLine ? [secondaryLine] : [],
	};
}

let piModule: ExtensionAPI;

export default function (ext: ExtensionAPI) {
	piModule = ext;
	let enabled = true;
	let requestRender: (() => void) | undefined;
	let footerDataRef: FooterData | undefined;

	const refresh = () => requestRender?.();

	const clear = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("hipster-powerline-top", undefined);
		ctx.ui.setWidget("hipster-powerline-secondary", undefined);
		ctx.ui.setFooter(undefined);
	};

	const apply = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setTheme("hipster-night");
		ctx.ui.setWorkingMessage("");
		ctx.ui.setWorkingIndicator({ frames: workingFrames(ctx), intervalMs: 1250 });

		ctx.ui.setFooter((tui, _theme, footerData) => {
			footerDataRef = footerData;
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				invalidateGitStatus();
				tui.requestRender();
			});
			return {
				dispose: () => {
					unsub();
					footerDataRef = undefined;
				},
				invalidate: refresh,
				render: () => [],
			};
		});

		ctx.ui.setWidget(
			"hipster-powerline-top",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					invalidate: refresh,
					render(width: number): string[] {
						return renderRows(piModule, ctx, theme, footerDataRef, width, refresh).top;
					},
				};
			},
			{ placement: "aboveEditor" },
		);

		ctx.ui.setWidget(
			"hipster-powerline-secondary",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				return {
					invalidate: refresh,
					render(width: number): string[] {
						return renderRows(piModule, ctx, theme, footerDataRef, width, refresh).secondary;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	ext.on("session_start", async (_event, ctx) => apply(ctx));
	ext.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) clear(ctx);
	});
	ext.on("model_select", async () => refresh());
	ext.on("thinking_level_select", async () => refresh());
	ext.on("message_end", async () => refresh());
	ext.on("tool_execution_end", async (event) => {
		if (["bash", "edit", "write"].includes(event.toolName)) invalidateGitStatus();
		refresh();
	});

	ext.registerCommand("think", {
		description: "Set or cycle thinking level: off|minimal|low|medium|high|xhigh|next|prev.",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const values = [...THINKING_LEVELS, "next", "prev"];
			const items = values
				.map((value) => ({ value, label: value }))
				.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "next" || arg === "+") return cycleThinking(piModule, ctx, 1);
			if (arg === "prev" || arg === "previous" || arg === "-") return cycleThinking(piModule, ctx, -1);
			if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) {
				ctx.ui.notify(`usage: /think ${THINKING_LEVELS.join("|")}|next|prev`, "warning");
				return;
			}
			setThinking(piModule, ctx, arg as ThinkingLevel);
		},
	});

	ext.registerCommand("t", {
		description: "Short alias for /think.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "next" || arg === "+") return cycleThinking(piModule, ctx, 1);
			if (arg === "prev" || arg === "previous" || arg === "-") return cycleThinking(piModule, ctx, -1);
			if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) {
				return ctx.ui.notify(`usage: /t ${THINKING_LEVELS.join("|")}|next|prev`, "warning");
			}
			setThinking(piModule, ctx, arg as ThinkingLevel);
		},
	});

	ext.registerShortcut("ctrl+shift+t", {
		description: "Cycle thinking level forward",
		handler: async (ctx) => cycleThinking(piModule, ctx, 1),
	});

	ext.registerShortcut("alt+t", {
		description: "Cycle thinking level backward",
		handler: async (ctx) => cycleThinking(piModule, ctx, -1),
	});

	ext.registerCommand("hipster-status", {
		description: "Toggle the hipster powerline widgets.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "off" ? false : arg === "on" ? true : !enabled;

			if (enabled) {
				apply(ctx);
				ctx.ui.notify("✨ hipster powerline enabled", "info");
			} else {
				clear(ctx);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWorkingIndicator();
				ctx.ui.notify("hipster powerline disabled", "info");
			}
		},
	});
}
