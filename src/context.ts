import { redactCommand } from "./redact.ts";
import { CAPS, type MnemonicStore } from "./store.ts";

const SECTION = "pi-mnemonic";

function list(items: string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

export function BuildContext(store: MnemonicStore, maxChars = 4000): string {
	const hot = store.hot();
	const lines = [
		"Cached environment memory. Fetch exact values with PiMnemonicGet; interpolate with PiMnemonicRender; call PiMnemonicHelp for the full API.",
		"",
		"Hot registers:",
		list(hot.registers.map((r) => `${r.name} (hits=${r.hits}) ~ ${r.preview}`)),
		"",
		"Generalizable facts:",
		list(hot.facts),
		"",
		"Recent work:",
		list(hot.episodes),
		"",
		"Reusable techniques:",
		list(hot.techniques),
		"",
		"Hot paths:",
		list(hot.paths),
		"",
		"Hot commands:",
		list(hot.commands),
		"",
		`Caps: ${CAPS.registers} registers, ${CAPS.facts} facts, ${CAPS.episodes} episodes, ${CAPS.techniques} techniques.`,
	];
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function BuildAssociations(store: MnemonicStore, query: string, maxChars = 1200): string {
	const hits = store.Recall(query, 4);
	if (!hits.length) return "";
	const lines = [
		"Associated techniques from prior work (fetch details with PiMnemonicRecall or PiMnemonicGet):",
		...hits.map((hit) => `- ${hit.Kind} ${hit.Key} [${hit.Score}] ${hit.Text}`),
	];
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function ContextSectionName(): string {
	return SECTION;
}

export function RecallSectionName(): string {
	return "pi-mnemonic-recall";
}

export function AssociateSectionName(): string {
	return "pi-mnemonic-associate";
}

export function BuildAssociateContext(store: MnemonicStore, prompt: string, lastResponse: string, maxChars = 2200): string {
	const hits = store.Recall(`${prompt}\n${lastResponse}`, 5);
	if (!hits.length) return "";
	const lines = [
		"Passive association: similar prior work. Consider what worked, what failed, the trajectory and outcome, and what lesson transfers here. Verify before relying on it.",
		...hits.map((hit) => `- ${hit.Kind} ${hit.Key} [${hit.Score}] ${hit.Text}`),
	];
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function LinkSectionName(): string {
	return "pi-mnemonic-links";
}

export function BuildLinkHints(store: MnemonicStore, maxChars = 1500): string {
	const links = store
		.list("link_", true)
		.filter((row) => Array.isArray(row.tags) && (row.tags as string[]).includes("md-link"))
		.slice(0, 8)
		.map((row) => {
			const value = row.value as Record<string, unknown> | undefined;
			const Summary = typeof value?.Summary === "string" ? value.Summary : String(row.preview || "");
			const Target = typeof value?.Target === "string" ? value.Target : String(row.key);
			return `- ${row.key}: ${redactCommand(Summary).slice(0, 140)} (${redactCommand(Target).slice(0, 160)})`;
		});
	if (!links.length) return "";
	const text = ["Warmed markdown references (open with read/fetch when useful):", ...links].join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
