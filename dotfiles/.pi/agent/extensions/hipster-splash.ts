import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CAT_LOGO = [
	"        ╭──────────────────╮        ",
	"        │  pi.dev ready   │        ",
	"        ╰────────┬─────────╯        ",
	"                 │                  ",
	"          /ᐠ｡ꞈ｡ᐟ\\                 ",
	"       ╭─/  づ  π づ─╮             ",
	"       ╰─┬──────────┬─╯             ",
	"        ◜▔◝      ◜▔◝               ",
];

const AUTO_DISMISS_SECONDS = 18;
const MAX_RESOURCE_ITEMS = 9;

type Command = ReturnType<ExtensionAPI["getCommands"]>[number];
type ThemeColor = Parameters<Theme["fg"]>[0];
type ContextUsage = { tokens: number; contextWindow?: number; percent?: number };
type LoadedResources = {
	contextFiles: string[];
	extensions: number;
	extensionCommands: string[];
	skills: string[];
	prompts: string[];
};

function compactHome(value: string): string {
	const home = os.homedir();
	return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function shortModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "model not selected";
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

function contextUsage(ctx: ExtensionContext): { label: string; color: ThemeColor } {
	const usage = ctx.getContextUsage() as ContextUsage | undefined;
	if (!usage) return { label: "fresh context", color: "dim" };

	const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage.percent ?? (contextWindow > 0 ? (usage.tokens / contextWindow) * 100 : null);
	const percentText = percent === null ? "" : ` ${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
	const color: ThemeColor = percent !== null && percent >= 90 ? "error" : percent !== null && percent >= 70 ? "warning" : "dim";
	return { label: `${fmtTokens(usage.tokens)}${percentText}`, color };
}

function commandLabel(command: Command): string {
	const label = command.name.replace(/:\d+$/, "");
	return command.source === "skill" && !label.startsWith("skill:") ? `skill:${label}` : label;
}

function resourceList(pi: ExtensionAPI, source: Command["source"]): string[] {
	return [...new Set(pi.getCommands().filter((command) => command.source === source).map(commandLabel))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function contextFiles(cwd: string): string[] {
	const files: string[] = [];
	const globalAgents = path.join(os.homedir(), ".pi", "agent", "AGENTS.md");
	if (existsSync(globalAgents)) files.push(globalAgents);

	let current = cwd;
	while (true) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const candidate = path.join(current, name);
			if (existsSync(candidate)) files.push(candidate);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return [...new Set(files)];
}

function countExtensionFiles(cwd: string): number {
	const dirs = [path.join(os.homedir(), ".pi", "agent", "extensions"), path.join(cwd, ".pi", "extensions")];
	const names = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				const entryPath = path.join(dir, entry);
				try {
					const stats = statSync(entryPath);
					if (stats.isDirectory() && (existsSync(path.join(entryPath, "index.ts")) || existsSync(path.join(entryPath, "package.json")))) {
						names.add(entry);
					} else if (stats.isFile() && /\.[jt]s$/.test(entry) && !entry.startsWith(".")) {
						names.add(entry.replace(/\.[jt]s$/, ""));
					}
				} catch {
					// Ignore unreadable extension entries.
				}
			}
		} catch {
			// Ignore unreadable extension dirs.
		}
	}
	return names.size;
}

function collectResources(pi: ExtensionAPI, ctx: ExtensionContext): LoadedResources {
	return {
		contextFiles: contextFiles(ctx.cwd),
		extensions: countExtensionFiles(ctx.cwd),
		extensionCommands: resourceList(pi, "extension"),
		skills: resourceList(pi, "skill").map((name) => name.replace(/^skill:/, "")),
		prompts: resourceList(pi, "prompt").map((name) => (name.startsWith("/") ? name : `/${name}`)),
	};
}

function color(theme: Theme, name: ThemeColor, text: string): string {
	return theme.fg(name, text);
}

function logoLine(line: string, row: number, theme: Theme): string {
	const colors = ["accent", "mdHeading", "mdLink", "success"] as const;
	return [...line].map((char, index) => (char === " " ? char : theme.fg(colors[(index + row) % colors.length]!, char))).join("");
}

function fitAnsi(value: string, width: number, ellipsis = "…"): string {
	return truncateToWidth(value, Math.max(0, width), ellipsis);
}

function padAnsi(value: string, width: number, align: "left" | "center" = "left"): string {
	const fitted = fitAnsi(value, width);
	const gap = Math.max(0, width - visibleWidth(fitted));
	if (align === "center") {
		const left = Math.floor(gap / 2);
		return `${" ".repeat(left)}${fitted}${" ".repeat(gap - left)}`;
	}
	return `${fitted}${" ".repeat(gap)}`;
}

function centerAnsi(value: string, width: number): string {
	return padAnsi(value, width, "center");
}

function border(theme: Theme, text: string): string {
	return color(theme, "borderMuted", text);
}

function boxTop(width: number, theme: Theme): string {
	const title = color(theme, "accent", " tiny cat ops ");
	const titleWidth = visibleWidth(title);
	const left = 3;
	const fill = Math.max(0, width - 2 - left - titleWidth);
	return border(theme, "╭" + "─".repeat(left)) + title + border(theme, "─".repeat(fill) + "╮");
}

function boxBottom(width: number, theme: Theme, countdown: number): string {
	const text = color(theme, "dim", ` any key dismisses · ${countdown}s `);
	const innerWidth = width - 2;
	const left = Math.max(0, Math.floor((innerWidth - visibleWidth(text)) / 2));
	const right = Math.max(0, innerWidth - visibleWidth(text) - left);
	return border(theme, "╰" + "─".repeat(left)) + text + border(theme, "─".repeat(right) + "╯");
}

function boxLine(content: string, width: number, theme: Theme, align: "left" | "center" = "left"): string {
	const inner = Math.max(0, width - 4);
	return border(theme, "│ ") + padAnsi(content, inner, align) + border(theme, " │");
}

function twoColumnLine(left: string, right: string, leftWidth: number, rightWidth: number, boxWidth: number, theme: Theme): string {
	const content = padAnsi(left, leftWidth) + color(theme, "dim", " │ ") + padAnsi(right, rightWidth);
	return boxLine(content, boxWidth, theme);
}

function systemSummary(resources: LoadedResources, theme: Theme): string {
	const parts = [
		color(theme, "success", `${resources.contextFiles.length}`) + color(theme, "dim", " ctx"),
		color(theme, "success", `${resources.extensions}`) + color(theme, "dim", " ext"),
	];
	if (resources.extensionCommands.length > 0) {
		parts.push(color(theme, "success", `${resources.extensionCommands.length}`) + color(theme, "dim", " cmds"));
	}
	return parts.join(color(theme, "dim", " · "));
}

function resourceBlock(title: string, items: string[], theme: Theme, width: number, limit = MAX_RESOURCE_ITEMS): string[] {
	const visible = items.slice(0, limit);
	const extra = items.length - visible.length;
	return [
		color(theme, "mdHeading", title),
		...(visible.length > 0
			? visible.map((item) => color(theme, "accent", "  ◆ ") + color(theme, "text", fitAnsi(item, Math.max(0, width - 4))))
			: [color(theme, "dim", "  none loaded")]),
		...(extra > 0 ? [color(theme, "dim", `  … ${extra} more`)] : []),
	];
}

function hasSessionActivity(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => {
		if (entry.type !== "message") return false;
		return entry.message.role === "assistant";
	});
}

function renderWelcome(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	width: number,
	countdown: number,
	resources: LoadedResources,
): string[] {
	if (width < 34) {
		return [centerAnsi(color(theme, "accent", "π ready"), width), centerAnsi(color(theme, "dim", "press any key"), width)];
	}

	const boxWidth = Math.min(width, 92);
	const model = shortModel(ctx);
	const context = contextUsage(ctx);
	const cwd = compactHome(ctx.cwd);
	const tips = `${color(theme, "accent", "/")} commands  ${color(theme, "accent", "!")} bash  ${color(theme, "accent", "shift+tab")} think`;
	const contextLine = `${color(theme, "muted", "context ")}${color(theme, context.color, context.label)}${color(theme, "dim", ` · pi ${VERSION}`)}`;
	const summary = systemSummary(resources, theme);
	const lines = [boxTop(boxWidth, theme), boxLine("", boxWidth, theme)];

	if (boxWidth >= 82) {
		const innerWidth = boxWidth - 4;
		const leftWidth = 42;
		const rightWidth = innerWidth - leftWidth - 3;
		const leftPanel = [
			...CAT_LOGO.map((line, index) => centerAnsi(logoLine(line, index, theme), leftWidth)),
			centerAnsi(color(theme, "mdHeading", "little cat online"), leftWidth),
			centerAnsi(color(theme, "muted", fitAnsi(model, leftWidth)), leftWidth),
			centerAnsi(contextLine, leftWidth),
			centerAnsi(color(theme, "dim", fitAnsi(cwd, leftWidth)), leftWidth),
			centerAnsi(summary, leftWidth),
			centerAnsi(tips, leftWidth),
		];
		const rightPanel = [
			...resourceBlock("Skills", resources.skills, theme, rightWidth, 7),
			"",
			...resourceBlock("Prompts", resources.prompts, theme, rightWidth, 7),
		];
		const rowCount = Math.max(leftPanel.length, rightPanel.length);
		for (let i = 0; i < rowCount; i++) {
			lines.push(twoColumnLine(leftPanel[i] ?? "", rightPanel[i] ?? "", leftWidth, rightWidth, boxWidth, theme));
		}
	} else {
		for (const line of CAT_LOGO) lines.push(boxLine(logoLine(line, 0, theme), boxWidth, theme, "center"));
		lines.push(boxLine(color(theme, "mdHeading", "little cat online"), boxWidth, theme, "center"));
		lines.push(boxLine(color(theme, "muted", fitAnsi(model, boxWidth - 8)), boxWidth, theme, "center"));
		lines.push(boxLine(contextLine, boxWidth, theme, "center"));
		lines.push(boxLine(color(theme, "dim", fitAnsi(cwd, boxWidth - 8)), boxWidth, theme, "center"));
		lines.push(boxLine(summary, boxWidth, theme, "center"));
		lines.push(boxLine("", boxWidth, theme));
		for (const line of resourceBlock("Skills", resources.skills, theme, boxWidth - 4, 5)) lines.push(boxLine(line, boxWidth, theme));
		for (const line of resourceBlock("Prompts", resources.prompts, theme, boxWidth - 4, 5)) lines.push(boxLine(line, boxWidth, theme));
		lines.push(boxLine(tips, boxWidth, theme, "center"));
	}

	lines.push(boxBottom(boxWidth, theme, countdown));
	return lines.map((line) => centerAnsi(line, width));
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let sessionGeneration = 0;
	let activeDismiss: (() => void) | undefined;
	let agentActive = false;

	const dismissActive = () => {
		activeDismiss?.();
		activeDismiss = undefined;
	};

	function showOverlay(ctx: ExtensionContext, force = false): void {
		if (!ctx.hasUI || !enabled || activeDismiss) return;
		if (!force && (agentActive || hasSessionActivity(ctx))) return;

		const overlayGeneration = sessionGeneration;
		const resources = collectResources(pi, ctx);

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					let countdown = AUTO_DISMISS_SECONDS;
					let closed = false;
					let interval: ReturnType<typeof setInterval> | undefined;

					const dismiss = () => {
						if (closed) return;
						closed = true;
						if (interval) clearInterval(interval);
						activeDismiss = undefined;
						done();
					};

					activeDismiss = dismiss;
					interval = setInterval(() => {
						if (closed) return;
						countdown--;
						if (countdown <= 0 || overlayGeneration !== sessionGeneration) {
							dismiss();
							return;
						}
						tui.requestRender();
					}, 1_000);

					return {
						invalidate: () => tui.requestRender(),
						render: (renderWidth: number): string[] => renderWelcome(pi, ctx, theme, renderWidth, countdown, resources),
						handleInput: () => dismiss(),
						dispose: () => {
							closed = true;
							if (interval) clearInterval(interval);
							activeDismiss = undefined;
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "82%",
						minWidth: 48,
						maxWidth: 96,
						visible: (termWidth: number, termHeight: number) => termWidth >= 40 && termHeight >= 14,
					},
				},
			)
			.catch((error) => {
				console.debug("[hipster-splash] overlay failed:", error);
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration++;
		const generation = sessionGeneration;
		setTimeout(() => {
			if (generation === sessionGeneration) showOverlay(ctx);
		}, 100);
	});
	pi.on("agent_start", async () => {
		agentActive = true;
		dismissActive();
	});
	pi.on("agent_end", async () => {
		agentActive = false;
	});
	pi.on("session_shutdown", async () => {
		sessionGeneration++;
		agentActive = false;
		dismissActive();
	});

	pi.registerCommand("hipster-splash", {
		description: "Show or toggle the temporary Pi welcome overlay.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				enabled = false;
				dismissActive();
				ctx.ui.notify("π splash disabled", "info");
				return;
			}

			if (arg === "on" || arg === "show") {
				enabled = true;
				showOverlay(ctx, true);
				return;
			}

			enabled = !enabled;
			if (enabled) {
				showOverlay(ctx, true);
			} else {
				dismissActive();
				ctx.ui.notify("π splash disabled", "info");
			}
		},
	});
}
