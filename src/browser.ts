import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MnemonicStore } from "./store.ts";

export interface ConflictInfo {
	Detected: boolean;
	Mode: string;
}

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

interface Keybindings {
	matches(data: string, action: string): boolean;
}

const VIEWS = ["Registers", "Facts", "Episodes", "Techniques", "Cold", "Usage"] as const;
type View = (typeof VIEWS)[number];
const VIEWPORT = 16;

function fg(theme: any, token: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(token, text) : text;
}

function dim(theme: any, text: string): string {
	return fg(theme, "dim", text);
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function header(theme: any, title: string, width: number): string {
	const label = ` ${title} `;
	const rest = Math.max(0, width - 2 - visibleWidth(label));
	const left = Math.floor(rest / 2);
	const right = rest - left;
	return fg(theme, "border", "╭" + "─".repeat(left)) + fg(theme, "accent", label) + fg(theme, "border", "─".repeat(right) + "╮");
}

function footer(theme: any, text: string, width: number): string {
	const inner = Math.max(1, width - 2);
	return fg(theme, "border", "╰" + truncateToWidth(pad(text, inner), inner) + "╯");
}

function row(theme: any, text: string, width: number): string {
	const inner = Math.max(1, width - 2);
	return fg(theme, "border", "│") + truncateToWidth(pad(text, inner), inner) + fg(theme, "border", "│");
}

function viewRows(store: MnemonicStore, view: View, theme: any): string[] {
	if (view === "Registers") {
		const rows = store.list("", false).slice(0, 200);
		return [fg(theme, "muted", "KEY".padEnd(28) + "HITS   BYTES  PREVIEW"), ...rows.map((r) => `${pad(String(r.key), 28)} ${String(r.hits).padStart(4)} ${String(r.bytes).padStart(7)}  ${String(r.preview)}`)];
	}
	if (view === "Facts") {
		return store.ListFacts(100).map((f) => `${f.pinned ? fg(theme, "warning", "PIN ") : ""}${pad(String(f.id), 18)} ${String(f.hits).padStart(4)}  ${String(f.claim)}`);
	}
	if (view === "Episodes") {
		return store.ListEpisodes(100).map((e) => `${e.pinned ? fg(theme, "warning", "PIN ") : ""}${pad(String(e.id), 18)} ${String(e.summary)}`);
	}
	if (view === "Techniques") {
		return store.ListTechniques(100).map((t) => `${t.expose ? fg(theme, "accent", "EXPOSED ") : ""}${pad(String(t.name), 22)} ${String(t.hits).padStart(4)}  ${String(t.description)}`);
	}
	if (view === "Cold") {
		return store.ListCold(100).map((c) => `${pad(String(c.kind), 11)} ${pad(String(c.key), 30)} sig=${String(c.signal).padStart(3)} ${String(c.reason)}`);
	}
	const stats = store.UsageStats();
	const rows = [`TOTAL ${stats.Total} / cap ${stats.Cap}`];
	for (const group of (stats.ByTool as Array<Record<string, unknown>>).slice(0, 40)) {
		rows.push(`${pad(String(group.Name), 28)} calls=${String(group.Calls).padStart(4)} ok=${String(group.Success).padStart(4)} err=${String(group.Errors).padStart(3)} avg=${String(group.AvgMs).padStart(5)}ms`);
	}
	return rows;
}

export function BuildRegisterPanel(
	store: MnemonicStore,
	conflict: ConflictInfo,
	view: View,
	width: number,
	theme?: any,
	scrollOffset = 0,
): string[] {
	const boxWidth = Math.min(Math.max(48, width), 100);
	const inner = Math.max(1, boxWidth - 2);
	const rows = viewRows(store, view, theme);
	const maxScroll = Math.max(0, rows.length - VIEWPORT);
	const offset = Math.max(0, Math.min(scrollOffset, maxScroll));
	const visible = rows.length ? rows.slice(offset, offset + VIEWPORT) : [dim(theme, view === "Cold" ? "  cold storage empty" : "  (empty)")];
	const tabs = VIEWS.map((name, index) => {
		const label = `${index + 1}:${name}`;
		return name === view ? fg(theme, "accent", `[${label}]`) : dim(theme, label);
	}).join(" ");
	const conflictText = conflict.Detected ? `engram detected (${fg(theme, "warning", conflict.Mode)})` : dim(theme, "engram not detected");
	return [
		header(theme, "pi-mnemonic registers", boxWidth),
		row(theme, `view ${view}  •  ${conflictText}`, boxWidth),
		row(theme, tabs, boxWidth),
		...visible.map((line) => row(theme, line, boxWidth)),
		footer(theme, `↑↓ scroll  •  1-6 view  •  r refresh  •  esc close${maxScroll ? `  •  ${offset + 1}-${Math.min(rows.length, offset + VIEWPORT)}/${rows.length}` : ""}`, boxWidth),
	].map((line) => truncateToWidth(line, boxWidth));
}

export function CreateRegisterBrowser(
	store: MnemonicStore,
	conflict: ConflictInfo,
	tui: { requestRender(): void },
	theme: any,
	keybindings: Keybindings | undefined,
	done: () => void,
): Component {
	let viewIndex = 0;
	let scrollOffset = 0;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const refresh = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
		store.flush();
		tui.requestRender();
	};
	const matches = (data: string, action: string) => Boolean(keybindings?.matches?.(data, action) || matchesKey(data, action as any));
	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			cachedWidth = width;
			cachedLines = BuildRegisterPanel(store, conflict, VIEWS[viewIndex], width, theme, scrollOffset);
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matches(data, "escape") || matches(data, "ctrl+c")) return done();
			if (matches(data, "up")) scrollOffset = Math.max(0, scrollOffset - 1);
			else if (matches(data, "down")) scrollOffset += 1;
			else if (matches(data, "pageUp")) scrollOffset = Math.max(0, scrollOffset - VIEWPORT);
			else if (matches(data, "pageDown")) scrollOffset += VIEWPORT;
			else if (data === "r" || data === "R") return refresh();
			else {
				const n = Number(data);
				if (Number.isInteger(n) && n >= 1 && n <= VIEWS.length) {
					viewIndex = n - 1;
					scrollOffset = 0;
				} else return;
			}
			refresh();
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
		dispose(): void {},
	};
}
