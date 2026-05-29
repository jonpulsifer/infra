import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem, visibleWidth } from "@earendil-works/pi-tui";
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

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function shortModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "no model";
	return `${model.provider}/${model.id}`
		.replace(/^openai-codex\//, "codex/")
		.replace(/^anthropic\//, "claude/")
		.replace(/^google\//, "gemini/")
		.replace(/claude-(sonnet|opus)-/, "$1-")
		.replace(/gpt-/, "gpt");
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function branchStats(ctx: ExtensionContext): { input: number; output: number; cost: number; messages: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	let messages = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		messages++;
		if (entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}

	return { input, output, cost, messages };
}

function contextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage) return "ctx: fresh";

	const contextWindow = ctx.model?.contextWindow;
	const pct = contextWindow ? ` ${(usage.tokens / contextWindow * 100).toFixed(0)}%` : "";
	return `ctx: ${fmtTokens(usage.tokens)}${pct}`;
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

function setThinking(pi: ExtensionAPI, ctx: ExtensionContext, level: ThinkingLevel) {
	const before = pi.getThinkingLevel();
	pi.setThinkingLevel(level);
	const after = pi.getThinkingLevel();
	const suffix = after === level ? "" : ctx.ui.theme.fg("dim", ` (clamped from ${level})`);
	ctx.ui.notify(`🧠 thinking: ${before} → ${after}${suffix}`, "info");
}

function cycleThinking(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1) {
	const current = pi.getThinkingLevel();
	const index = THINKING_LEVELS.indexOf(current as ThinkingLevel);
	const next = THINKING_LEVELS[(Math.max(0, index) + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length]!;
	setThinking(pi, ctx, next);
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext, setRenderHook: (requestRender: () => void) => void) {
	ctx.ui.setWorkingMessage("");
	ctx.ui.setWorkingIndicator({
		frames: workingFrames(ctx),
		intervalMs: 1250,
	});

	ctx.ui.setFooter((tui, theme, footerData) => {
		setRenderHook(() => tui.requestRender());
		const unsubs = [footerData.onBranchChange(() => tui.requestRender())];

		return {
			dispose: () => unsubs.forEach((unsub) => unsub()),
			invalidate() {},
			render(width: number): string[] {
				const stats = branchStats(ctx);
				const branch = footerData.getGitBranch();
				const thinking = pi.getThinkingLevel();

				const left = [
					theme.fg("accent", "🤖 " + shortModel(ctx)),
					theme.fg("muted", ">"),
					theme.fg("thinkingMedium", `🧠 ${thinking}`),
					theme.fg("muted", "/"),
					theme.fg("warning", `🪟 ${contextLabel(ctx)}`),
					theme.fg("muted", ">"),
					theme.fg("mdHeading", `🛸 ${sessionLabel(pi, ctx)}`),
				].join(" ");

				const right = [
					branch ? theme.fg("success", `🌱 ${branch}`) : theme.fg("dim", "🌑 no git"),
					theme.fg("dim", `💬 ${stats.messages}`),
					theme.fg("dim", `↥${fmtTokens(stats.input)} ↧${fmtTokens(stats.output)}`),
					theme.fg("dim", `☕ $${stats.cost.toFixed(3)}`),
				].join(theme.fg("muted", "  ·  "));

				const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + gap + right, width, "…")];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | undefined;

	const apply = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setTheme("hipster-night");
		installFooter(pi, ctx, (render) => {
			requestRender = render;
		});
	};

	pi.on("session_start", async (_event, ctx) => apply(ctx));
	pi.on("model_select", async () => requestRender?.());
	pi.on("thinking_level_select", async () => requestRender?.());
	pi.on("message_end", async () => requestRender?.());

	pi.registerCommand("think", {
		description: "Set or cycle thinking level: off|minimal|low|medium|high|xhigh|next|prev.",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const values = [...THINKING_LEVELS, "next", "prev"];
			const items = values.map((value) => ({ value, label: value })).filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "next" || arg === "+") return cycleThinking(pi, ctx, 1);
			if (arg === "prev" || arg === "previous" || arg === "-") return cycleThinking(pi, ctx, -1);
			if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) {
				ctx.ui.notify(`usage: /think ${THINKING_LEVELS.join("|")}|next|prev`, "warning");
				return;
			}
			setThinking(pi, ctx, arg as ThinkingLevel);
		},
	});

	pi.registerCommand("t", {
		description: "Short alias for /think.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "next" || arg === "+") return cycleThinking(pi, ctx, 1);
			if (arg === "prev" || arg === "previous" || arg === "-") return cycleThinking(pi, ctx, -1);
			if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) return ctx.ui.notify(`usage: /t ${THINKING_LEVELS.join("|")}|next|prev`, "warning");
			setThinking(pi, ctx, arg as ThinkingLevel);
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Cycle thinking level forward",
		handler: async (ctx) => cycleThinking(pi, ctx, 1),
	});

	pi.registerShortcut("alt+t", {
		description: "Cycle thinking level backward",
		handler: async (ctx) => cycleThinking(pi, ctx, -1),
	});

	pi.registerCommand("hipster-status", {
		description: "Toggle the hipster footer/status line.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "off" ? false : arg === "on" ? true : !enabled;

			if (enabled) {
				apply(ctx);
				ctx.ui.notify("✨ hipster status enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.setWorkingMessage();
				ctx.ui.setWorkingIndicator();
				ctx.ui.notify("hipster status disabled", "info");
			}
		},
	});
}
