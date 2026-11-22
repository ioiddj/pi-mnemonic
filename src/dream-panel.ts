import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface DreamConfigView {
	Enabled: boolean;
	IdleMs: number;
	Depth: number;
	SweepKb: number;
	PromptKeys: string[];
	PromptSource: Record<string, string>;
}

export interface DreamPanelResult {
	Save: boolean;
	Enabled: boolean;
	IdleMs: number;
	Depth: number;
	SweepKb: number;
	EditKey?: string;
}

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

function fg(theme: any, token: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(token, text) : text;
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function header(theme: any, title: string, width: number): string {
	const label = ` ${title} `;
	const rest = Math.max(0, width - 2 - visibleWidth(label));
	const left = Math.floor(rest / 2);
	return fg(theme, "border", "╭" + "─".repeat(left)) + fg(theme, "accent", label) + fg(theme, "border", "─".repeat(rest - left) + "╮");
}

function footer(theme: any, text: string, width: number): string {
	return fg(theme, "border", "╰" + truncateToWidth(pad(text, Math.max(1, width - 2)), Math.max(1, width - 2)) + "╯");
}

function row(theme: any, text: string, width: number): string {
	const inner = Math.max(1, width - 2);
	return fg(theme, "border", "│") + truncateToWidth(pad(text, inner), inner) + fg(theme, "border", "│");
}

export function BuildDreamPanel(config: DreamConfigView, selected: number, theme: any, width: number): string[] {
	const w = Math.min(Math.max(56, width), 92);
	const lines = [
		header(theme, "idle miner control", w),
		row(theme, `${fg(theme, config.Enabled ? "success" : "warning", config.Enabled ? "ENABLED" : "DISABLED")}  •  opt-in idle worker`, w),
		row(theme, `idle time   ${String(Math.round(config.IdleMs / 1000)).padStart(5)}s   (-/+)`, w),
		row(theme, `depth       ${String(config.Depth).padStart(5)}     ([/])`, w),
		row(theme, `sweep       ${String(config.SweepKb).padStart(5)}KB  ({/})`, w),
		row(theme, "", w),
		row(theme, fg(theme, "muted", "prompt cards (j/k select, e edit):"), w),
	];
	config.PromptKeys.slice(0, 8).forEach((key, index) => {
		const marker = index === selected ? fg(theme, "accent", ">") : " ";
		const source = config.PromptSource[key] || "default";
		lines.push(row(theme, `${marker} ${pad(key, 24)} ${fg(theme, source === "card" ? "success" : "dim", source)}`, w));
	});
	lines.push(footer(theme, "space toggle  •  -/+ idle  •  [/] depth  •  {/} sweep  •  e edit  •  enter save  •  esc cancel", w));
	return lines.map((line) => truncateToWidth(line, w));
}

export function CreateDreamPanel(
	initial: DreamConfigView,
	tui: { requestRender(): void },
	theme: any,
	keybindings: { matches(data: string, action: string): boolean } | undefined,
	done: (result: DreamPanelResult) => void,
): Component {
	const state = { ...initial, PromptKeys: [...initial.PromptKeys] };
	let selected = 0;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const refresh = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
		tui.requestRender();
	};
	const matches = (data: string, semantic: string, fallback: string) => Boolean(keybindings?.matches?.(data, semantic) || matchesKey(data, fallback as any));
	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			cachedWidth = width;
			cachedLines = BuildDreamPanel(state, selected, theme, width);
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matches(data, "tui.select.cancel", "escape")) return done({ Save: false, Enabled: state.Enabled, IdleMs: state.IdleMs, Depth: state.Depth, SweepKb: state.SweepKb });
			if (data === " ") state.Enabled = !state.Enabled;
			else if (data === "-" || data === "_") state.IdleMs = Math.max(1000, state.IdleMs - 5000);
			else if (data === "+" || data === "=") state.IdleMs = Math.min(600_000, state.IdleMs + 5000);
			else if (data === "[") state.Depth = Math.max(1, state.Depth - 1);
			else if (data === "]") state.Depth = Math.min(50, state.Depth + 1);
			else if (data === "{") state.SweepKb = Math.max(16, state.SweepKb - 32);
			else if (data === "}") state.SweepKb = Math.min(4096, state.SweepKb + 32);
			else if (matches(data, "tui.select.up", "up")) selected = Math.max(0, selected - 1);
			else if (matches(data, "tui.select.down", "down")) selected = Math.min(Math.max(0, state.PromptKeys.length - 1), selected + 1);
			else if (data === "e" || data === "E") return done({ Save: true, Enabled: state.Enabled, IdleMs: state.IdleMs, Depth: state.Depth, SweepKb: state.SweepKb, EditKey: state.PromptKeys[selected] });
			else if (matches(data, "tui.select.confirm", "enter")) return done({ Save: true, Enabled: state.Enabled, IdleMs: state.IdleMs, Depth: state.Depth, SweepKb: state.SweepKb });
			else return;
			refresh();
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		dispose(): void {},
	};
}
