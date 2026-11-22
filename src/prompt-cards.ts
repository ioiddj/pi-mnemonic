import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROMPTS } from "./prompt-defaults.ts";

const EXTENSION_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROMPT_DIR = path.join(EXTENSION_DIR, ".config", "prompts");
const MAX_CARDS = 32;
const MAX_PROMPT_BYTES = 32 * 1024;

interface Card {
	key: string;
	prompt: string;
}

let cache: Map<string, Card> | undefined;
let cacheStamp = "";

function ParseCard(raw: string, filename: string): { key: string; prompt: string } | undefined {
	let key = "";
	let prompt = "";
	let mode: "" | "|" | ">" = "";
	let indent: number | undefined;
	const block: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (mode) {
			if (!line.trim()) {
				block.push("");
				continue;
			}
			const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
			if (indent === undefined) indent = currentIndent;
			if (currentIndent < indent) break;
			block.push(line.slice(Math.min(indent, line.length)));
			continue;
		}
		const keyMatch = /^key:\s*([^#\n]+)$/.exec(line);
		if (keyMatch) {
			key = keyMatch[1].trim().replace(/^["']|["']$/g, "");
			continue;
		}
		const promptMatch = /^prompt:\s*(.*)$/.exec(line);
		if (promptMatch) {
			const value = promptMatch[1].trim();
			if (value.startsWith("|") || value.startsWith(">")) mode = value[0] as "|" | ">";
			else prompt = value.replace(/^["']|["']$/g, "");
		}
	}
	if (mode) {
		while (block.length && !block[block.length - 1].trim()) block.pop();
		prompt = mode === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
	}
	if (!key) key = path.basename(filename).replace(/\.ya?ml$/i, "");
	return prompt ? { key, prompt } : undefined;
}

function Files(): fs.Dirent[] {
	try {
		return fs.readdirSync(PROMPT_DIR, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, MAX_CARDS);
	} catch {
		cache = undefined;
		cacheStamp = "";
		return [];
	}
}

function Fingerprint(entries: fs.Dirent[]): string {
	return entries.map((entry) => {
		try {
			const stat = fs.statSync(path.join(PROMPT_DIR, entry.name));
			return `${entry.name}|${stat.mtimeMs}|${stat.size}|${stat.ino}`;
		} catch {
			return `${entry.name}|missing`;
		}
	}).join(";");
}

function LoadCards(): Map<string, Card> {
	const entries = Files();
	const stamp = Fingerprint(entries);
	if (cache && stamp === cacheStamp) return cache;
	const cards = new Map<string, Card>();
	for (const entry of entries) {
		const file = path.join(PROMPT_DIR, entry.name);
		try {
			const parsed = ParseCard(fs.readFileSync(file, "utf8"), entry.name);
			if (parsed && !cards.has(parsed.key)) cards.set(parsed.key, parsed);
		} catch {
			// Broken cards fall back to defaults.
		}
	}
	cache = cards;
	cacheStamp = stamp;
	return cards;
}

export function PromptText(key: string, vars: Record<string, unknown> = {}): string {
	const card = LoadCards().get(key);
	let text = card?.prompt || DEFAULT_PROMPTS[key] || "";
	for (const [name, value] of Object.entries(vars)) {
		text = text.split(`{{${name}}}`).join(String(value));
	}
	return text;
}

export function PromptKeys(): string[] {
	return [...new Set([...Object.keys(DEFAULT_PROMPTS), ...LoadCards().keys()])].slice(0, MAX_CARDS);
}

export function WritePromptCard(key: string, prompt: string): string {
	if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROMPTS, key)) throw new Error(`Unknown prompt key '${key}'.`);
	const clean = String(prompt).trim();
	if (Buffer.byteLength(clean, "utf8") > MAX_PROMPT_BYTES) throw new Error(`Prompt too large (${Buffer.byteLength(clean, "utf8")} > ${MAX_PROMPT_BYTES} bytes).`);
	fs.mkdirSync(PROMPT_DIR, { recursive: true, mode: 0o700 });
	const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
	const file = path.join(PROMPT_DIR, `${safe}.yaml`);
	try {
		const existing = fs.lstatSync(file);
		if (existing.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${file}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const body = `key: ${key}\ndescription: Editable prompt card for ${key}\nprompt: |\n${clean.split("\n").map((line) => `  ${line}`).join("\n")}\n`;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
	fs.renameSync(tmp, file);
	cache = undefined;
	cacheStamp = "";
	return file;
}

export function ResetPromptCard(key: string): string {
	return WritePromptCard(key, DEFAULT_PROMPTS[key]);
}

export function PromptSource(key: string): "card" | "default" | "none" {
	if (LoadCards().has(key)) return "card";
	if (DEFAULT_PROMPTS[key]) return "default";
	return "none";
}
