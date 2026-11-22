/**
 * Markdown link warming and bounded sibling-link weaving. Local targets are
 * confined to explicit roots; remote URLs are stored without credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MnemonicStore } from "./store.ts";
import { redactCommand } from "./redact.ts";
import { AtomicUpdateText } from "./file-lock.ts";

export interface WarmedLink {
	readonly Kind: "file" | "url";
	readonly Target: string;
	readonly Label: string;
	readonly Summary: string;
	readonly Preview: string;
	readonly Key: string;
}

const MAX_PREVIEW_BYTES = 8192;
const MAX_LINKS_PER_FILE = 40;

function slug(target: string): string {
	const hash = createHash("sha1").update(target).digest("hex").slice(0, 8);
	const base = path.basename(target).replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase().slice(0, 48) || "link";
	return `link_${base}_${hash}`;
}

function summaryFrom(text: string, fallback: string): { summary: string; preview: string } {
	const lines = text.split(/\r?\n/);
	const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
	const body = lines.find((line, index) => index > 0 && line.trim() && !/^#{1,6}\s/.test(line) && !/^[-*>\d]/.test(line));
	const summary = (heading || body || fallback).replace(/^#+\s*/, "").trim().slice(0, 180) || fallback;
	return { summary, preview: lines.slice(0, 12).join("\n").slice(0, 1200) };
}

export function WarmMarkdownLinks(
	store: MnemonicStore,
	markdown: string,
	basePath: string,
	depth = 1,
	allowedRoots?: string | string[],
): WarmedLink[] {
	const requestedRoots = Array.isArray(allowedRoots) ? allowedRoots : allowedRoots ? [allowedRoots] : [process.cwd()];
	const roots = requestedRoots
		.flatMap((root) => {
			try {
				return [fs.realpathSync(path.resolve(root))];
			} catch {
				return [];
			}
		});
	const withinRoots = (target: string) => !roots.length || roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
	const warmed: WarmedLink[] = [];
	const visited = new Set<string>();
	const queue: Array<{ text: string; base: string; level: number }> = [{ text: markdown, base: basePath, level: 0 }];
	const maxDepth = Math.max(0, Math.min(3, depth));

	while (queue.length && warmed.length < MAX_LINKS_PER_FILE) {
		const current = queue.shift()!;
		if (visited.has(current.base)) continue;
		visited.add(current.base);
		const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(current.text)) !== null && warmed.length < MAX_LINKS_PER_FILE) {
			const Label = match[1].trim();
			const raw = match[2].trim().split(/\s+/)[0];
			if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("data:")) continue;
			const isUrl = /^https?:\/\//i.test(raw);
			let target = raw;
			if (!isUrl) {
				let resolved: string;
				try {
					resolved = path.resolve(path.dirname(current.base), decodeURIComponent(raw.split("#")[0]));
				} catch {
					continue;
				}
				try {
					target = fs.realpathSync(resolved);
					if (!withinRoots(target)) continue;
					const stat = fs.statSync(target);
					if (!stat.isFile() && !stat.isDirectory()) continue;
					if (stat.isFile() && stat.nlink > 1) continue;
				} catch {
					continue;
				}
			}
			if (visited.has(target)) continue;
			visited.add(target);
			let Summary = Label;
			let Preview = isUrl ? `Remote URL: ${raw}` : "";
			if (!isUrl) {
				try {
					const stat = fs.statSync(target);
					if (stat.isDirectory()) {
						const entries = fs.readdirSync(target).slice(0, 8).join(", ");
						Preview = `Local directory: ${target}${entries ? `\nEntries: ${entries}` : ""}`;
					} else if (stat.size > MAX_PREVIEW_BYTES) {
						Preview = `Local file: ${target} (${stat.size} bytes)`;
					} else if (stat.size) {
						const fd = fs.openSync(target, "r");
						const buffer = Buffer.alloc(stat.size);
						let read = 0;
						try {
							read = fs.readSync(fd, buffer, 0, buffer.length, 0);
						} finally {
							fs.closeSync(fd);
						}
						if (buffer.slice(0, read).includes(0)) Preview = "Binary file";
						else {
							const parsed = summaryFrom(buffer.slice(0, read).toString("utf8"), Label);
							Summary = parsed.summary;
							Preview = parsed.preview;
						}
					}
				} catch {
					Preview = "Local reference could not be read.";
				}
			}
			Summary = redactCommand(Summary);
			const SafeTarget = isUrl ? redactCommand(target) : target;
			const Key = slug(target);
			store.set(Key, { Kind: isUrl ? "url" : "file", Target: SafeTarget, Label, Summary, Preview }, ["md-link", isUrl ? "url" : "file"]);
			warmed.push({ Kind: isUrl ? "url" : "file", Target: SafeTarget, Label, Summary, Preview, Key });
			if (!isUrl && current.level < maxDepth && /\.md$/i.test(target) && fs.existsSync(target)) {
				const text = fs.readFileSync(target, "utf8").slice(0, MAX_PREVIEW_BYTES);
				queue.push({ text, base: target, level: current.level + 1 });
			}
		}
	}
	return warmed;
}

export function WeaveRelatedLinks(markdownPath: string, maxLinks = 10, allowedRoot?: string): { file: string; added: string[] } {
	const resolved = path.resolve(markdownPath);
	if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error("Refusing to weave a symlinked file.");
	const rootReal = allowedRoot ? fs.realpathSync(path.resolve(allowedRoot)) : fs.realpathSync(process.cwd());
	const resolvedReal = fs.realpathSync(resolved);
	if (!(resolvedReal === rootReal || resolvedReal.startsWith(`${rootReal}${path.sep}`))) throw new Error("Markdown file is outside the allowed root.");
	if (!/\.md$/i.test(resolved)) throw new Error("PiMnemonicLink Weave requires a markdown file.");
	const stat = fs.statSync(resolvedReal);
	if (!stat.isFile() || stat.size > 200_000 || stat.nlink > 1) throw new Error("Markdown file is not a readable bounded regular file.");
	const dir = path.dirname(resolved);
	const siblings = fs.readdirSync(dir)
		.filter((name) => /\.md$/i.test(name) && path.join(dir, name) !== resolvedReal)
		.slice(0, Math.max(1, Math.min(20, maxLinks)));
	let added: string[] = [];
	AtomicUpdateText(resolvedReal, (text) => {
		const existing = new Set([...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
		added = siblings
			.filter((name) => !existing.has(name) && !existing.has(`./${name}`))
			.map((name) => {
				const label = name.replace(/\.md$/i, "").replace(/[\][()\r\n]/g, " ").slice(0, 80);
				return `- [${label}](${encodeURIComponent(name)})`;
			});
		if (!added.length) return text;
		const section = `\n\n## Related\n\n${added.join("\n")}\n`;
		if (text.length + section.length > 150_000) {
			added = [];
			return text;
		}
		return `${text}${section}`;
	}, "", 150_000);
	return { file: resolvedReal, added };
}
