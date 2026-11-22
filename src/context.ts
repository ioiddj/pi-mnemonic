import { redactCommand } from "./redact.ts";
import { CAPS, ProjectKey, type MnemonicStore } from "./store.ts";

const SCOPE_STOP = new Set(["with", "that", "this", "from", "into", "about", "should", "could", "please", "remember", "project"]);

export function ScopeTags(store: MnemonicStore, cwd: string, prompt: string, limit = 3): string[] {
	const words = new Set(String(prompt || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((word) => word.length >= 4 && !SCOPE_STOP.has(word)));
	const allTags = store.allTags();
	const projectBare = new Set(allTags.filter((tag) => tag.startsWith("project:")).map((tag) => tag.slice(8)));
	const concepts = allTags
		.filter((tag) => !tag.startsWith("project:") && !projectBare.has(tag) && !["md-link", "url", "file", "fleet-mined"].includes(tag))
		.filter((tag) => [...words].some((word) => tag.includes(word)))
		.slice(0, limit);
	const project = ProjectKey(cwd);
	return project ? [`project:${project}`, ...concepts] : concepts;
}

export function ScopedRecall(store: MnemonicStore, query: string, cwd: string, limit = 8): { hits: ReturnType<MnemonicStore["Recall"]>; tags: string[] } {
	const tags = ScopeTags(store, cwd, query);
	const project = tags.filter((tag) => tag.startsWith("project:"));
	const concepts = tags.filter((tag) => !tag.startsWith("project:"));
	for (const attempt of [{ tags: tags.slice(0, 4), mode: "all" as const }, { tags: project, mode: "any" as const }, { tags: concepts, mode: "any" as const }]) {
		if (!attempt.tags.length) continue;
		const hits = store.Recall(query, limit, { tags: attempt.tags, mode: attempt.mode });
		if (hits.length) return { hits, tags: attempt.tags };
	}
	return { hits: store.Recall(query, limit), tags: [] };
}

const SECTION = "pi-mnemonic";

function list(items: string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

export function BuildContext(store: MnemonicStore, maxChars = 4000): string {
	const hot = store.hot();
	const safe = (value: string) => redactCommand(value);
	const lines = [
		"Cached environment memory. Fetch exact values with PiMnemonicGet; interpolate with PiMnemonicRender; call PiMnemonicHelp for the full API.",
		"",
		"Hot registers:",
		list(hot.registers.map((r) => safe(`${r.name} (hits=${r.hits}) ~ ${r.preview}`))),
		"",
		"Generalizable facts:",
		list(hot.facts.map(safe)),
		"",
		"Recent work:",
		list(hot.episodes.map(safe)),
		"",
		"Reusable techniques:",
		list(hot.techniques.map(safe)),
		"",
		"Hot paths:",
		list(hot.paths.map(safe)),
		"",
		"Hot commands:",
		list(hot.commands.map(safe)),
		"",
		`Caps: ${CAPS.registers} registers, ${CAPS.facts} facts, ${CAPS.episodes} episodes, ${CAPS.techniques} techniques.`,
	];
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function BuildAssociations(store: MnemonicStore, query: string, maxChars = 1200, cwd = ""): string {
	const { hits, tags } = ScopedRecall(store, query, cwd, 4);
	if (!hits.length) return "";
	const scope = tags.length ? ` Scope: ${redactCommand(tags.join(", "))}.` : "";
	const lines = [
		`Associated techniques from prior work (fetch details with PiMnemonicRecall or PiMnemonicGet):${scope}`,
		...hits.map((hit) => `- ${hit.Kind} ${redactCommand(hit.Key)} [${hit.Score}] ${redactCommand(hit.Text)}`),
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

export function BuildAssociateContext(store: MnemonicStore, prompt: string, lastResponse: string, maxChars = 2200, cwd = ""): string {
	const { hits, tags } = ScopedRecall(store, `${prompt}\n${lastResponse}`, cwd, 5);
	if (!hits.length) return "";
	const scope = tags.length ? ` Scope: ${redactCommand(tags.join(", "))}.` : "";
	const lines = [
		`Passive association: similar prior work. Consider what worked, what failed, the trajectory and outcome, and what lesson transfers here. Verify before relying on it.${scope}`,
		...hits.map((hit) => `- ${hit.Kind} ${redactCommand(hit.Key)} [${hit.Score}] ${redactCommand(hit.Text)}`),
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
