/**
 * Mustache rendering helpers with secret protection and bounded cached-value hints.
 */
import { randomUUID } from "node:crypto";
import Handlebars from "../vendor/handlebars-ai/index.ts";
import { redactCommand } from "./redact.ts";

const env = Handlebars.create();
const HINT_INLINE_CHARS = 1200;

function GetAt(value: unknown, key: string | number): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "object") return undefined;
	return (value as Record<string | number, unknown>)[key];
}

function HelperRoot(options: unknown): unknown {
	const data = GetAt(options, "data");
	return data && typeof data === "object" ? GetAt(data, "root") : undefined;
}

function HintMissing(lookup: string, root: unknown): string {
	let node: unknown = root;
	for (const part of lookup.split(".").filter(Boolean).slice(0, -1)) {
		if (!node || typeof node !== "object") break;
		node = GetAt(node, part);
	}
	const keys = node && typeof node === "object" ? Object.keys(node).slice(0, 8) : [];
	return keys.length ? `[missing store key: ${lookup}] Nearby keys: ${keys.join(", ")}.` : `[missing store key: ${lookup}]`;
}

env.registerHelper("hint", function (key: unknown, options: unknown): string {
	if (typeof key !== "string") return "";
	const lookup = key.trim().slice(0, 128);
	if (!lookup) return "";
	const root = HelperRoot(options);
	let current: unknown = root;
	for (const part of lookup.split(".").filter(Boolean)) {
		if (current === null || typeof current !== "object") return HintMissing(lookup, root);
		current = GetAt(current, part);
	}
	if (current === undefined || current === null) return HintMissing(lookup, root);
	let text: string;
	try {
		text = typeof current === "string" ? current : JSON.stringify(current);
	} catch {
		text = String(current);
	}
	const normalized = text.replace(/\s+/g, " ").trim();
	const shown = redactCommand(normalized.slice(0, HINT_INLINE_CHARS));
	const truncated = normalized.length > shown.length || normalized.length > HINT_INLINE_CHARS;
	return `- ${lookup}: ${shown}${truncated ? " Truncated; exact value: PiMnemonicGet Key=" + lookup + "." : ""}`;
});

env.registerHelper("count", (value: unknown) => {
	if (value && typeof value === "object" && "hash" in value && "data" in value && "fn" in value) return 0;
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === "object") return Object.keys(value as object).length;
	return 0;
});

env.registerHelper("at", (value: unknown, path: unknown): unknown => {
	let current: unknown = value;
	for (const part of String(path ?? "").split(".").filter(Boolean)) {
		if (current === null || current === undefined) return undefined;
		current = GetAt(current, /^\d+$/.test(part) ? Number(part) : part);
	}
	return current;
});

export function RenderMarkdown(template: string, context: Record<string, unknown> = {}): string {
	const secrets: string[] = [];
	const prefix = `__PI_MNEMONIC_${randomUUID().replace(/-/g, "")}_`;
	const protectedText = template.replace(/\{\{(?:secret|credential):[^}]+\}\}/g, (token) => {
		secrets.push(token);
		return `${prefix}${secrets.length - 1}__`;
	});
	const rendered = RenderTemplate(protectedText, context);
	return secrets.reduce((text, token, index) => text.split(`${prefix}${index}__`).join(token), rendered);
}

export function RenderTemplate(template: string, context: Record<string, unknown> = {}): string {
	try {
		return env.compile(template, { noEscape: true, strict: false })(context) as string;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Template render failed: ${message}. Hint: check {{references}} and pass Vars for missing keys.`);
	}
}
