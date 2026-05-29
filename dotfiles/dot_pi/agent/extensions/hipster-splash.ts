import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOGO = [
	"        ╭──────────────────╮        ",
	"        │  booting pi.dev  │        ",
	"        ╰────────┬─────────╯        ",
	"                 │                  ",
	"          /ᐠ｡ꞈ｡ᐟ\\                 ",
	"       ╭─/  づ  💾 づ─╮             ",
	"       ╰─┬──────────┬─╯             ",
	"        ◜▔◝      ◜▔◝               ",
];

const MAX_SECTION_ITEMS = 12;

type Command = ReturnType<ExtensionAPI["getCommands"]>[number];

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
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function contextUsage(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage) return "fresh context";

	const contextWindow = ctx.model?.contextWindow;
	const pct = contextWindow ? ` ${(usage.tokens / contextWindow * 100).toFixed(0)}%` : "";
	return `${fmtTokens(usage.tokens)}${pct}`;
}

function centerAnsi(value: string, width: number): string {
	const padding = Math.max(0, Math.floor((width - visibleWidth(value)) / 2));
	return `${" ".repeat(padding)}${value}`;
}

function padRightAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function logoLine(line: string, row: number, theme: Theme): string {
	const colors = ["accent", "mdHeading", "mdLink", "success"] as const;
	return [...line]
		.map((char, index) => (char === " " ? char : theme.fg(colors[(index + row) % colors.length]!, char)))
		.join("");
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

	return [...new Set(files)].map((file) => {
		const relative = path.relative(cwd, file);
		return relative && !relative.startsWith("..") ? relative : compactHome(file);
	});
}

function bullet(item: string, theme: Theme, width: number): string {
	return truncateToWidth(`${theme.fg("dim", "  • ")}${theme.fg("text", item)}`, width, "…");
}

function section(title: string, items: string[], theme: Theme, width: number): string[] {
	const count = items.length;
	const heading = `${theme.fg("mdHeading", title)} ${theme.fg("dim", `(${count})`)}`;
	const visible = items.slice(0, MAX_SECTION_ITEMS);
	const extra = count - visible.length;
	return [
		"",
		truncateToWidth(heading, width, "…"),
		...(visible.length > 0 ? visible.map((item) => bullet(item, theme, width)) : [theme.fg("dim", "  none")]),
		...(extra > 0 ? [theme.fg("dim", `  … ${extra} more`)] : []),
	];
}

function renderSplash(pi: ExtensionAPI, ctx: ExtensionContext, theme: Theme, width: number): string[] {
	const skills = resourceList(pi, "skill");
	const prompts = resourceList(pi, "prompt").map((name) => `/${name}`);
	const contexts = contextFiles(ctx.cwd);
	const columns = width >= 92;
	const sectionWidth = columns ? Math.floor((width - 4) / 3) : width;
	const contextSection = section("Context", contexts, theme, sectionWidth);
	const skillSection = section("Skills", skills, theme, sectionWidth);
	const promptSection = section("Prompts", prompts, theme, sectionWidth);

	const output = [""];
	for (let index = 0; index < LOGO.length; index++) output.push(centerAnsi(logoLine(LOGO[index]!, index, theme), width));
	output.push(centerAnsi(theme.fg("mdHeading", "Welcome to Pi") + theme.fg("dim", `  v${VERSION}`), width));
	output.push(centerAnsi(theme.fg("muted", `${shortModel(ctx)} · ${pi.getThinkingLevel()} thinking · ${contextUsage(ctx)}`), width));

	if (!columns) {
		output.push(...contextSection, ...skillSection, ...promptSection, "");
		return output.map((line) => truncateToWidth(line, width, "…"));
	}

	const rows = Math.max(contextSection.length, skillSection.length, promptSection.length);
	for (let index = 0; index < rows; index++) {
		const left = truncateToWidth(contextSection[index] ?? "", sectionWidth, "…");
		const middle = truncateToWidth(skillSection[index] ?? "", sectionWidth, "…");
		const right = truncateToWidth(promptSection[index] ?? "", sectionWidth, "…");
		output.push(`${padRightAnsi(left, sectionWidth)}  ${padRightAnsi(middle, sectionWidth)}  ${right}`);
	}
	output.push("");
	return output.map((line) => truncateToWidth(line, width, "…"));
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | undefined;

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				render(width: number): string[] {
					return renderSplash(pi, ctx, theme, width);
				},
				invalidate() {
					tui.requestRender();
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => install(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
	pi.on("model_select", async () => requestRender?.());
	pi.on("thinking_level_select", async () => requestRender?.());
	pi.on("resources_discover", async () => requestRender?.());

	pi.registerCommand("hipster-splash", {
		description: "Toggle the Emacs-style Pi startup splash/header.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "off" ? false : arg === "on" ? true : !enabled;

			if (enabled) {
				install(ctx);
				ctx.ui.notify("π splash enabled", "info");
			} else {
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("π splash disabled", "info");
			}
		},
	});
}
