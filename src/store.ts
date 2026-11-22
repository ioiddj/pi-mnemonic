/**
 * Bounded mnemonic store: locked atomic persistence, per-field merge,
 * associative recall, pruning/cold storage, and usage accounting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactCommand } from "./redact.ts";
import { AtomicWriteText, FileStamp, WithFileLock } from "./file-lock.ts";

export interface PinMeta {
	pinned?: boolean;
	pinnedScopes?: string[];
}

export interface ColdItem {
	Id: string;
	Kind: string;
	Key: string;
	Data: unknown;
	Reason: string;
	At: number;
	Signal?: number;
}

export const CAPS = {
	registers: 500,
	registerBytes: 256 * 1024,
	valueBytes: 64 * 1024,
	facts: 300,
	episodes: 100,
	techniques: 100,
	dynamicTools: 20,
	paths: 100,
	commands: 200,
	cold: 200,
	coldBytes: 1024 * 1024,
	usage: 2000,
	tombstones: 256,
	hotItems: 5,
} as const;

export function TagSlug(value: unknown): string {
	return String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function ProjectKey(cwd: unknown): string {
	const parts = String(cwd || "").replace(/\\/g, "/").split("/").filter(Boolean);
	const marker = parts.findIndex((part) => ["projects", "workspace", "repositories", "repos"].includes(part.toLowerCase()));
	return TagSlug(marker >= 0 ? parts[marker + 1] : parts.at(-1));
}

export interface RegisterMeta extends PinMeta {
	value: unknown;
	tags: string[];
	hits: number;
	createdAt: number;
	lastUsedAt: number;
	fieldTimes?: Record<string, number>;
	fieldRemoved?: Record<string, boolean>;
}

export interface Fact extends PinMeta {
	id: string;
	claim: string;
	tags: string[];
	confidence: number;
	source: string;
	hits: number;
	createdAt: number;
	lastUsedAt: number;
}

export interface Episode extends PinMeta {
	id: string;
	summary: string;
	detail?: string;
	tags: string[];
	hits: number;
	createdAt: number;
	lastUsedAt: number;
}

export interface Technique extends PinMeta {
	id: string;
	name: string;
	command: string;
	description: string;
	usage: string;
	params: string[];
	cwd?: string;
	tags: string[];
	expose: boolean;
	hits: number;
	createdAt: number;
	lastUsedAt: number;
}

export interface RecallHit {
	Kind: "Register" | "Fact" | "Episode" | "Technique";
	Key: string;
	Text: string;
	Score: number;
	Tags: string[];
	Matched?: string[];
}

export interface RecallOptions {
	readonly tags?: readonly string[];
	readonly mode?: "all" | "any";
}

export interface MergeConflict {
	readonly Key: string;
	readonly At: number;
	readonly Values: readonly string[];
}

export interface Counted extends PinMeta {
	key: string;
	hits: number;
	lastSeenAt: number;
}

export interface UsageEvent {
	Id: string;
	At: number;
	Tool: string;
	Action: string;
	DurationMs: number;
	Success: boolean;
	ErrorCode?: string;
	InputBytes: number;
	OutputBytes: number;
	Model?: string;
	Trigger?: string;
	Meta?: Record<string, unknown>;
}

export interface MnemonicState {
	version: 1;
	updatedAt: number;
	registers: Record<string, RegisterMeta>;
	facts: Fact[];
	episodes: Episode[];
	techniques: Technique[];
	paths: Counted[];
	commands: Counted[];
	usage: UsageEvent[];
	tombstones: Record<string, number>;
	conflicts: MergeConflict[];
}

type Scored = { hits: number; createdAt?: number; lastUsedAt?: number; lastSeenAt?: number };

const DEFAULT_STATE = (): MnemonicState => ({
	version: 1,
	updatedAt: Date.now(),
	registers: {},
	facts: [],
	episodes: [],
	techniques: [],
	paths: [],
	commands: [],
	usage: [],
	tombstones: {},
	conflicts: [],
});

export function resolveStatePath(): string {
	const base = process.env.PI_CODING_AGENT_DIR
		? path.join(process.env.PI_CODING_AGENT_DIR, "pi-mnemonic")
		: path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-mnemonic");
	return path.join(base, "store.json");
}

function id(prefix: string): string {
	return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function score(item: Scored, now = Date.now()): number {
	const stamp = item.lastUsedAt ?? item.lastSeenAt ?? item.createdAt ?? now;
	return (item.hits || 0) + 1 / (1 + Math.max(0, now - stamp) / 86_400_000);
}

function trim<T extends Scored>(items: T[], cap: number): T[] {
	if (items.length <= cap) return items;
	return [...items].sort((a, b) => score(b) - score(a)).slice(0, cap);
}

const INTERNAL_CONFLICT_PREFIXES = ["reflect.", "prune.", "charter.", "associate.", "background.", "dream.", "meta.", "observability."];

function PushConflict(conflicts: MergeConflict[], conflict: MergeConflict): void {
	if (INTERNAL_CONFLICT_PREFIXES.some((prefix) => conflict.Key.startsWith(prefix))) return;
	const signature = `${conflict.Key}|${[...conflict.Values].sort().join("|")}`;
	if (conflicts.some((entry) => `${entry.Key}|${[...entry.Values].sort().join("|")}` === signature)) return;
	conflicts.push(conflict);
}

interface Stamped {
	readonly lastUsedAt?: number;
	readonly lastSeenAt?: number;
	readonly createdAt?: number;
	readonly At?: number;
	readonly hits?: number;
}

function stampOf(value: unknown): number {
	const stamped = (value && typeof value === "object" ? value : {}) as Stamped;
	return Number(stamped.lastUsedAt ?? stamped.lastSeenAt ?? stamped.createdAt ?? stamped.At ?? 0) || 0;
}

/** Merge a local writer's changes into the on-disk state under the store lock. */
const FIELD_CAP = 128;
const LEAF_CAP = 256;

function fieldKey(tokens: Array<string | number>): string {
	return JSON.stringify(tokens);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capFieldTimes(times: Record<string, number> | undefined): Record<string, number> | undefined {
	if (!times) return undefined;
	return Object.fromEntries(Object.entries(times).sort((a, b) => b[1] - a[1]).slice(0, FIELD_CAP));
}

interface RegisterLeaf { value: unknown; time: number; removed: boolean }

function FlattenRegister(meta: RegisterMeta, prefix: Array<string | number> = [], inherited = 0, out = new Map<string, RegisterLeaf>()): Map<string, RegisterLeaf> | undefined {
	const value = prefix.length ? getAt(meta.value, prefix) : meta.value;
	const path = fieldKey(prefix);
	const time = meta.fieldTimes?.[path] ?? inherited;
	const entries: Array<[string | number, unknown]> = Array.isArray(value)
		? Array.from(value.entries())
		: isPlainObject(value) ? Object.entries(value) : [];
	if (entries.length) {
		for (let index = 0; index < entries.length; index++) {
			const key = entries[index][0];
			if (typeof key === "string" && RESERVED.has(key)) continue;
			if (out.size >= LEAF_CAP) return undefined;
			FlattenRegister(meta, [...prefix, key], time, out);
		}
		return out;
	}
	out.set(path, { value, time, removed: Boolean(meta.fieldRemoved?.[path]) });
	return out;
}

function MergeRegisterValue(key: string, local: RegisterMeta, disk: RegisterMeta, conflicts: MergeConflict[]): unknown {
	if (!isPlainObject(local.value) || !isPlainObject(disk.value)) return stampOf(local) >= stampOf(disk) ? local.value : disk.value;
	const ours = FlattenRegister(local);
	const theirs = FlattenRegister(disk);
	if (!ours || !theirs) return stampOf(local) >= stampOf(disk) ? local.value : disk.value;
	for (const path of new Set([...ours.keys(), ...theirs.keys()])) {
		const a = ours.get(path);
		const b = theirs.get(path);
		if (!a || !b) continue;
		const av = JSON.stringify(a.value ?? null);
		const bv = JSON.stringify(b.value ?? null);
		if (av !== bv && a.time && b.time && Math.abs(a.time - b.time) <= 30_000) PushConflict(conflicts, { Key: `${key}${path === "[]" ? "" : `.${path}`}`, At: Date.now(), Values: [bv.slice(0, 200), av.slice(0, 200)] });
	}
	let result: unknown = {};
	for (const path of new Set([...ours.keys(), ...theirs.keys()])) {
		const a = ours.get(path);
		const b = theirs.get(path);
		const aTime = a?.time ?? (local.fieldRemoved?.[path] ? local.fieldTimes?.[path] ?? 0 : 0);
		const bTime = b?.time ?? (disk.fieldRemoved?.[path] ? disk.fieldTimes?.[path] ?? 0 : 0);
		const useLocal = aTime >= bTime;
		const chosen = useLocal ? a : b;
		const removed = useLocal ? Boolean(local.fieldRemoved?.[path] || a?.removed) : Boolean(disk.fieldRemoved?.[path] || b?.removed);
		if (!chosen || removed) continue;
		result = setAt(result, JSON.parse(path) as Array<string | number>, chosen.value);
	}
	return result;
}

function MergeRegisterMeta(key: string, local: RegisterMeta, disk: RegisterMeta, conflicts: MergeConflict[]): RegisterMeta {
	if (!isPlainObject(local.value) && !isPlainObject(disk.value)) {
		const ours = JSON.stringify(local.value ?? null);
		const theirs = JSON.stringify(disk.value ?? null);
		const a = Number(local.fieldTimes?.["$"] ?? 0);
		const b = Number(disk.fieldTimes?.["$"] ?? 0);
		if (ours !== theirs && a && b && Math.abs(a - b) <= 30_000) PushConflict(conflicts, { Key: key, At: Date.now(), Values: [theirs.slice(0, 200), ours.slice(0, 200)] });
	}
	const fieldTimes = capFieldTimes({ ...disk.fieldTimes, ...local.fieldTimes });
	const fieldRemoved = Object.fromEntries(Object.entries({ ...disk.fieldRemoved, ...local.fieldRemoved }).slice(-FIELD_CAP));
	const value = MergeRegisterValue(key, local, disk, conflicts);
	const bytes = Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
	const safeValue = bytes > CAPS.valueBytes ? (stampOf(local) >= stampOf(disk) ? local.value : disk.value) : value;
	return {
		...disk,
		...local,
		value: safeValue,
		tags: [...new Set([...(disk.tags || []), ...(local.tags || [])])].slice(-20),
		hits: Math.max(disk.hits || 0, local.hits || 0),
		createdAt: Math.min(disk.createdAt || Date.now(), local.createdAt || Date.now()),
		lastUsedAt: Math.max(disk.lastUsedAt || 0, local.lastUsedAt || 0),
		fieldTimes,
		fieldRemoved: Object.keys(fieldRemoved).length ? fieldRemoved : undefined,
	};
}

function MergeStates(local: MnemonicState, disk: MnemonicState, removed: Set<string>, resurrected: Set<string>, conflicts: MergeConflict[]): MnemonicState {
	const rawTombstones: Record<string, number> = { ...disk.tombstones, ...local.tombstones };
	for (const key of removed) rawTombstones[key] = Date.now();
	for (const key of resurrected) delete rawTombstones[key];
	const cutoff = Date.now() - 30 * 86_400_000;
	const tombstones = Object.fromEntries(Object.entries(rawTombstones).filter(([, at]) => at > cutoff).sort((a, b) => b[1] - a[1]).slice(0, CAPS.tombstones));
	const isDead = (key: string, item: unknown) => (tombstones[key] || 0) >= stampOf(item);
	const registers: Record<string, RegisterMeta> = {};
	for (const [key, meta] of Object.entries(disk.registers)) if (!isDead(key, meta)) registers[key] = meta;
	for (const [key, meta] of Object.entries(local.registers)) {
		if (isDead(key, meta)) continue;
		registers[key] = registers[key] ? MergeRegisterMeta(key, meta, registers[key], conflicts) : meta;
	}
	const merge = <T>(ours: readonly T[], theirs: readonly T[], keyOf: (item: T) => string): T[] => {
		const merged = new Map<string, T>();
		for (const item of [...theirs, ...ours]) {
			const key = keyOf(item);
			if (!key || isDead(key, item)) continue;
			const prev = merged.get(key);
			if (!prev || stampOf(item) >= stampOf(prev)) merged.set(key, item);
		}
		return [...merged.values()];
	};
	const usage = new Map<string, UsageEvent>();
	for (const item of [...(disk.usage || []), ...(local.usage || [])]) if (item?.Id) usage.set(item.Id, item);
	return {
		...local,
		registers,
		facts: merge(local.facts, disk.facts, (f) => f?.claim?.trim().toLowerCase() || f?.id),
		episodes: merge(local.episodes, disk.episodes, (e) => e?.summary?.trim().toLowerCase() || e?.id),
		techniques: merge(local.techniques, disk.techniques, (t) => t?.name),
		paths: merge(local.paths, disk.paths, (p) => p?.key),
		commands: merge(local.commands, disk.commands, (c) => c?.key),
		usage: [...usage.values()].sort((a, b) => a.At - b.At).slice(-CAPS.usage),
		tombstones,
		conflicts: [...new Map([...(disk.conflicts || []), ...(local.conflicts || []), ...conflicts].map((entry) => [`${entry.Key}|${[...entry.Values].sort().join("|")}`, entry])).values()].slice(-20),
	};
}

function MergeCold(disk: ColdItem[], local: ColdItem[]): ColdItem[] {
	const merged = new Map<string, ColdItem>();
	for (const item of [...disk, ...local]) if (item?.Id) merged.set(item.Id, item);
	return [...merged.values()].sort((a, b) => a.At - b.At);
}

const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

function checkSegment(segment: string): void {
	if (segment.split(".").some((part) => RESERVED.has(part))) throw new Error(`Reserved path segment '${segment}'.`);
}

export function parsePath(key: string): Array<string | number> {
	const tokens: Array<string | number> = [];
	const re = /[^.[\]]+|\[(\d+)\]|\["([^"]+)"\]/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(key)) !== null) {
		if (match[1] !== undefined) {
			const index = Number(match[1]);
			if (!Number.isSafeInteger(index) || index < 0 || index > 1024) throw new Error("Array index must be 0-1024.");
			tokens.push(index);
		} else if (match[2] !== undefined) {
			checkSegment(match[2]);
			tokens.push(match[2]);
		} else {
			checkSegment(match[0]);
			tokens.push(match[0]);
		}
	}
	return tokens;
}

function getAt(root: unknown, tokens: Array<string | number>): unknown {
	let current: unknown = root;
	for (const token of tokens) {
		if (typeof token === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[token];
		} else {
			if (current === null || typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[token];
		}
	}
	return current;
}

function setAt(root: unknown, tokens: Array<string | number>, value: unknown): unknown {
	if (tokens.length === 0) return value;
	const result = root ?? (typeof tokens[0] === "number" ? [] : {});
	let container: unknown = result;
	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		const next = tokens[i + 1];
		const wantArray = typeof token === "number" || typeof next === "number";
		const child = typeof next === "number" ? [] : {};
		if (typeof token === "number") {
			if (!Array.isArray(container)) container = [];
			const array = container as unknown[];
			if (array[token] === undefined || array[token] === null) array[token] = child;
			container = array[token];
		} else {
			if (container === null || typeof container !== "object" || Array.isArray(container)) container = {};
			const object = container as Record<string, unknown>;
			if (object[token] === undefined || object[token] === null || wantArray !== Array.isArray(object[token])) object[token] = child;
			container = object[token];
		}
	}
	const last = tokens[tokens.length - 1];
	if (typeof last === "number") {
		if (!Array.isArray(container)) return result;
		(container as unknown[])[last] = value;
	} else if (container && typeof container === "object") {
		(container as Record<string, unknown>)[last] = value;
	}
	return result;
}

function deleteAt(root: unknown, tokens: Array<string | number>): unknown {
	if (tokens.length === 0) return undefined;
	let container: unknown = root;
	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		if (typeof token === "number") {
			if (!Array.isArray(container)) return root;
			container = container[token];
		} else {
			if (container === null || typeof container !== "object") return root;
			container = (container as Record<string, unknown>)[token];
		}
	}
	const last = tokens[tokens.length - 1];
	if (typeof last === "number" && Array.isArray(container)) container.splice(last, 1);
	else if (container && typeof container === "object") delete (container as Record<string, unknown>)[String(last)];
	return root;
}

const VECTOR_DIM = 256;

function TokenVector(text: string): Float64Array {
	const vector = new Float64Array(VECTOR_DIM);
	for (const token of String(text || "")
		.toLowerCase()
		.split(/[^a-z0-9_-]+/)
		.filter((word) => word.length >= 3)) {
		const digest = createHash("sha1").update(token).digest();
		const index = digest.readUInt16BE(0) % VECTOR_DIM;
		const sign = digest[2] % 2 === 0 ? 1 : -1;
		vector[index] += sign;
	}
	let norm = 0;
	for (const value of vector) norm += value * value;
	const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	if (scale) for (let i = 0; i < vector.length; i++) vector[i] *= scale;
	return vector;
}

function Cosine(a: Float64Array, b: Float64Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

export function clip(value: unknown, max: number): string {
	return String(value ?? "").slice(0, max);
}

function scrub(value: unknown, max: number): string {
	return redactCommand(clip(value, max));
}

function preview(value: unknown, length = 80): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export class MnemonicStore {
	readonly filePath: string;
	readonly coldFile: string;
	private state: MnemonicState;
	private dirty = false;
	private removed = new Set<string>();
	private resurrected = new Set<string>();

	constructor(filePath = resolveStatePath()) {
		this.filePath = filePath;
		this.coldFile = filePath.replace(/\.json$/, ".cold.json");
		this.state = this.load();
	}

	private markTombstone(key: string, at = Date.now()): void {
		this.state.tombstones ??= {};
		this.state.tombstones[key] = at;
		const cutoff = at - 30 * 86_400_000;
		this.state.tombstones = Object.fromEntries(Object.entries(this.state.tombstones).filter(([, stamp]) => stamp > cutoff).sort((a, b) => b[1] - a[1]).slice(0, CAPS.tombstones));
	}

	private load(): MnemonicState {
		try {
			if (!fs.existsSync(this.filePath)) return DEFAULT_STATE();
			const raw = fs.readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<MnemonicState>;
			if (parsed.version !== 1 || typeof parsed !== "object") throw new Error("unsupported state version");
			return {
				version: 1,
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
				registers: parsed.registers && typeof parsed.registers === "object" ? parsed.registers : {},
				facts: Array.isArray(parsed.facts) ? parsed.facts : [],
				episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
				techniques: Array.isArray(parsed.techniques) ? parsed.techniques : [],
				paths: Array.isArray(parsed.paths) ? parsed.paths : [],
				commands: Array.isArray(parsed.commands) ? parsed.commands : [],
				usage: Array.isArray(parsed.usage) ? (parsed.usage as UsageEvent[]).slice(-CAPS.usage) : [],
				tombstones: parsed.tombstones && typeof parsed.tombstones === "object" ? parsed.tombstones : {},
				conflicts: Array.isArray(parsed.conflicts) ? (parsed.conflicts as MergeConflict[]).slice(-20) : [],
			};
		} catch {
			try {
				fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
			} catch {
				// Quarantine is best-effort; an empty state is still safe.
			}
			return DEFAULT_STATE();
		}
	}

	flush(): void {
		if (!this.dirty) return;
		WithFileLock(this.filePath, () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const conflicts: MergeConflict[] = [];
				const before = FileStamp(this.filePath);
				const disk = this.load();
				this.state = MergeStates(this.state, disk, this.removed, this.resurrected, conflicts);
				this.state.updatedAt = Date.now();
				this.pruneAll();
				if (FileStamp(this.filePath) !== before) continue;
				AtomicWriteText(this.filePath, JSON.stringify(this.state, null, 2));
				this.removed.clear();
				this.resurrected.clear();
				return;
			}
			throw new Error(`Store changed concurrently: ${this.filePath}`);
		});
		this.dirty = false;
	}

	private mark(): void {
		this.pruneAll();
		this.dirty = true;
	}

	private pruneAll(): void {
		this.state.facts = trim(this.state.facts, CAPS.facts);
		this.state.episodes = trim(this.state.episodes, CAPS.episodes);
		this.state.techniques = trim(this.state.techniques, CAPS.techniques);
		this.state.paths = trim(this.state.paths, CAPS.paths);
		this.state.commands = trim(this.state.commands, CAPS.commands);
		this.state.usage = this.state.usage.slice(-CAPS.usage);

		const entries = Object.entries(this.state.registers);
		if (entries.length > CAPS.registers) {
			const kept = entries
				.map(([key, meta]) => ({ key, meta }))
				.sort((a, b) => score(b.meta) - score(a.meta))
				.slice(0, CAPS.registers);
			this.state.registers = Object.fromEntries(kept.map(({ key, meta }) => [key, meta]));
		}
		let bytes = Object.values(this.state.registers).reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.value ?? null) ?? "null", "utf8"), 0);
		if (bytes > CAPS.registerBytes) {
			const ordered = Object.entries(this.state.registers).sort((a, b) => score(a[1]) - score(b[1]));
			for (const [key, meta] of ordered) {
				if (bytes <= CAPS.registerBytes) break;
				bytes -= Buffer.byteLength(JSON.stringify(meta.value ?? null) ?? "null", "utf8");
				delete this.state.registers[key];
			}
		}
	}

	get(key: string): unknown {
		const tokens = parsePath(key);
		const root = tokens[0];
		if (typeof root !== "string") return undefined;
		const meta = this.state.registers[root];
		if (!meta) return undefined;
		const value = tokens.length === 1 ? meta.value : getAt(meta.value, tokens.slice(1));
		meta.hits = (meta.hits || 0) + 1;
		meta.lastUsedAt = Date.now();
		this.mark();
		return value;
	}

	peek(key: string): unknown {
		const tokens = parsePath(key);
		const root = tokens[0];
		if (typeof root !== "string") return undefined;
		const meta = this.state.registers[root];
		if (!meta) return undefined;
		return tokens.length === 1 ? meta.value : getAt(meta.value, tokens.slice(1));
	}

	set(key: string, value: unknown, tags: string[] = []): void {
		const tokens = parsePath(key);
		const root = tokens[0];
		if (typeof root !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(root)) {
			throw new Error(`Invalid register key '${key}'. Use a root name plus optional dot/bracket path.`);
		}
		const bytes = Buffer.byteLength(JSON.stringify(value ?? null) ?? "null", "utf8");
		if (bytes > CAPS.valueBytes) throw new Error(`Value too large (${bytes} > ${CAPS.valueBytes} bytes). Hint: store a key or path, not the whole blob.`);
		const now = Date.now();
		const meta = this.state.registers[root] ?? { value: undefined, tags: [], hits: 0, createdAt: now, lastUsedAt: now };
		if (tokens.length > 1 && meta.value !== undefined && (typeof meta.value !== "object" || meta.value === null)) {
			throw new Error(`Cannot set '${key}' because '${root}' is a scalar. Replace the root value first.`);
		}
		const composed = tokens.length === 1 ? value : setAt(meta.value, tokens.slice(1), value);
		const composedBytes = Buffer.byteLength(JSON.stringify(composed ?? null) ?? "null", "utf8");
		if (composedBytes > CAPS.valueBytes) throw new Error(`Value too large (${composedBytes} > ${CAPS.valueBytes} bytes).`);
		meta.value = composed;
		delete this.state.tombstones?.[root];
		delete this.state.tombstones?.[key];
		this.resurrected.add(root);
		this.resurrected.add(key);
		this.removed.delete(root);
		this.removed.delete(key);
		if (tokens.length > 1) {
			const relative = fieldKey(tokens.slice(1));
			meta.fieldTimes = capFieldTimes({ ...meta.fieldTimes, [relative]: now });
			if (meta.fieldRemoved?.[relative]) {
				const kept = { ...meta.fieldRemoved };
				delete kept[relative];
				meta.fieldRemoved = Object.keys(kept).length ? kept : undefined;
			}
		} else {
			meta.fieldTimes = capFieldTimes({ ...meta.fieldTimes, ["$"]: now });
		}
		if (tags.length) meta.tags = [...new Set([...(meta.tags || []), ...tags])].slice(-20);
		meta.lastUsedAt = now;
		this.state.registers[root] = meta;
		this.mark();
	}

	delete(key: string): boolean {
		const tokens = parsePath(key);
		const root = tokens[0];
		if (typeof root !== "string" || !this.state.registers[root]) return false;
		if (tokens.length === 1) {
			this.removed.add(key);
			this.markTombstone(key);
			delete this.state.registers[root];
		} else {
			const meta = this.state.registers[root];
			meta.value = deleteAt(meta.value, tokens.slice(1));
			meta.lastUsedAt = Date.now();
			const relative = fieldKey(tokens.slice(1));
			meta.fieldTimes = capFieldTimes({ ...meta.fieldTimes, [relative]: meta.lastUsedAt });
			meta.fieldRemoved = { ...meta.fieldRemoved, [relative]: true };
		}
		this.mark();
		return true;
	}

	list(prefix = "", includeValues = false): Array<Record<string, unknown>> {
		return Object.entries(this.state.registers)
			.filter(([key]) => key.startsWith(prefix))
			.sort((a, b) => score(b[1]) - score(a[1]))
			.map(([key, meta]) => {
				const row: Record<string, unknown> = {
					key,
					hits: meta.hits,
					tags: meta.tags,
					bytes: Buffer.byteLength(JSON.stringify(meta.value ?? null) ?? "null", "utf8"),
					updatedAt: meta.lastUsedAt,
				};
				if (includeValues) row.value = meta.value;
				else row.preview = preview(meta.value);
				return row;
			});
	}

	learn(claim: string, tags: string[] = [], confidence = 0.8, source = "agent"): Fact {
		claim = scrub(claim, 2048);
		const normalized = claim.trim().replace(/\s+/g, " ").toLowerCase();
		const existing = this.state.facts.find((f) => f.claim.trim().replace(/\s+/g, " ").toLowerCase() === normalized);
		const now = Date.now();
		if (existing) {
			existing.hits += 1;
			existing.lastUsedAt = now;
			existing.confidence = Math.max(existing.confidence, confidence);
			existing.tags = [...new Set([...existing.tags, ...tags])].slice(-20);
			this.mark();
			return existing;
		}
		const fact: Fact = {
			id: id("fact"),
			claim: claim.trim(),
			tags: [...new Set(tags.map((tag) => clip(tag, 64)))].slice(-20),
			confidence,
			source,
			hits: 1,
			createdAt: now,
			lastUsedAt: now,
		};
		this.state.facts.push(fact);
		this.mark();
		return fact;
	}

	note(summary: string, detail = "", tags: string[] = []): Episode {
		const episode: Episode = {
			id: id("ep"),
			summary: scrub(summary, 1024).trim(),
			detail: scrub(detail, 4096).trim() || undefined,
			tags: [...new Set(tags.map((tag) => clip(tag, 64)))].slice(-20),
			hits: 1,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		this.state.episodes.push(episode);
		this.mark();
		return episode;
	}

	techniqueAdd(input: {
		name: string;
		command: string;
		description?: string;
		usage?: string;
		params?: string[];
		cwd?: string;
		tags?: string[];
		expose?: boolean;
	}): Technique {
		const name = clip(input.name, 64).trim().toLowerCase();
		if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Technique name must match [a-z0-9_-]+.");
		const existing = this.state.techniques.find((r) => r.name === name);
		if (existing) {
			existing.command = input.command;
			existing.description = input.description || existing.description;
			existing.usage = input.usage || existing.usage;
			existing.params = input.params || existing.params;
			existing.cwd = input.cwd || existing.cwd;
			existing.tags = [...new Set([...existing.tags, ...(input.tags || [])])].slice(-20);
			existing.expose = input.expose ?? existing.expose;
			existing.lastUsedAt = Date.now();
			this.mark();
			return existing;
		}
		const technique: Technique = {
			id: id("technique"),
			name,
			command: String(input.command).slice(0, 4096),
			description: scrub(input.description || "Stored command technique", 1024),
			usage: scrub(input.usage || "Use PiTechnique for render/exec/script.", 1024),
			params: input.params || [],
			cwd: input.cwd,
			tags: [...new Set(input.tags || [])].slice(-20),
			expose: Boolean(input.expose),
			hits: 0,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		this.state.techniques.push(technique);
		this.mark();
		return technique;
	}

	techniqueGet(name: string): Technique | undefined {
		const technique = this.state.techniques.find((r) => r.name === name.toLowerCase());
		if (technique) {
			technique.hits += 1;
			technique.lastUsedAt = Date.now();
			this.mark();
		}
		return technique;
	}

	techniquePeek(name: string): Technique | undefined {
		return this.state.techniques.find((r) => r.name === name.toLowerCase());
	}

	allTechniques(): Technique[] {
		return [...this.state.techniques].sort((a, b) => score(b) - score(a));
	}

	techniqueList(): Array<Record<string, unknown>> {
		return [...this.state.techniques]
			.sort((a, b) => score(b) - score(a))
			.map((r) => ({
				name: r.name,
				description: r.description,
				params: r.params,
				expose: r.expose,
				hits: r.hits,
			}));
	}

	techniqueDelete(name: string): boolean {
		const before = this.state.techniques.length;
		this.state.techniques = this.state.techniques.filter((r) => r.name !== name.toLowerCase());
		const removed = this.state.techniques.length !== before;
		if (removed) {
			this.removed.add(name);
			this.mark();
		}
		return removed;
	}

	techniqueScript(name: string, renderedCommand: string): string {
		const dir = path.join(path.dirname(this.filePath), "scripts");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, `${name.replace(/[^a-z0-9_-]/g, "_")}.sh`);
		AtomicWriteText(file, `#!/usr/bin/env bash\nset -euo pipefail\n${renderedCommand}\n`, 0o700);
		return file;
	}

	pathHit(cwd: string): void {
		if (!cwd) return;
		const existing = this.state.paths.find((p) => p.key === cwd);
		if (existing) {
			existing.hits += 1;
			existing.lastSeenAt = Date.now();
		} else {
			this.state.paths.push({ key: cwd, hits: 1, lastSeenAt: Date.now() });
		}
		this.mark();
	}

	commandHit(command: string): void {
		const key = redactCommand(command);
		if (!key) return;
		const existing = this.state.commands.find((c) => c.key === key);
		if (existing) {
			existing.hits += 1;
			existing.lastSeenAt = Date.now();
		} else {
			this.state.commands.push({ key, hits: 1, lastSeenAt: Date.now() });
		}
		this.mark();
	}

	hot(): {
		registers: Array<{ name: string; hits: number; preview: string }>;
		facts: string[];
		episodes: string[];
		techniques: string[];
		paths: string[];
		commands: string[];
	} {
		const topRegisters = Object.entries(this.state.registers)
			.sort((a, b) => score(b[1]) - score(a[1]))
			.slice(0, CAPS.hotItems)
			.map(([name, meta]) => ({ name, hits: meta.hits, preview: preview(meta.value, 60) }));
		return {
			registers: topRegisters,
			facts: [...this.state.facts].sort((a, b) => score(b) - score(a)).slice(0, CAPS.hotItems).map((f) => f.claim.slice(0, 160)),
			episodes: [...this.state.episodes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, CAPS.hotItems).map((e) => e.summary.slice(0, 160)),
			techniques: [...this.state.techniques].sort((a, b) => score(b) - score(a)).slice(0, CAPS.hotItems).map((r) => r.name),
			paths: [...this.state.paths].sort((a, b) => score(b) - score(a)).slice(0, CAPS.hotItems).map((p) => p.key),
			commands: [...this.state.commands].sort((a, b) => score(b) - score(a)).slice(0, CAPS.hotItems).map((c) => c.key.slice(0, 120)),
		};
	}

	allTags(): string[] {
		const tags = new Set<string>();
		const collect = (values: string[]) => { for (const tag of values) if (tag) tags.add(tag); };
		for (const meta of Object.values(this.state.registers)) collect(meta.tags || []);
		for (const fact of this.state.facts) collect(fact.tags);
		for (const episode of this.state.episodes) collect(episode.tags);
		for (const technique of this.state.techniques) collect(technique.tags);
		return [...tags].slice(0, 200);
	}

	warm(keys: string[] = []): string[] {
		for (const key of keys) {
			const meta = this.state.registers[key];
			if (meta) {
				meta.hits += 1;
				meta.lastUsedAt = Date.now();
			}
		}
		this.mark();
		return this.hot().registers.map((r) => r.name);
	}

	compactSnapshot(): Record<string, unknown> {
		const hot = this.hot();
		return {
			version: 1,
			createdAt: Date.now(),
			registers: hot.registers.map((r) => r.name),
			facts: hot.facts,
			episodes: hot.episodes,
			techniques: hot.techniques,
			paths: hot.paths,
		};
	}

	mergeCompact(data: unknown): void {
		if (!data || typeof data !== "object") return;
		const snap = data as Record<string, unknown>;
		const now = Date.now();
		for (const claim of Array.isArray(snap.facts) ? snap.facts.slice(0, 12) : []) {
			if (typeof claim === "string" && claim.trim()) this.learn(claim, ["compacted"], 0.7, "session_compact");
		}
		for (const summary of Array.isArray(snap.episodes) ? snap.episodes.slice(0, 6) : []) {
			if (typeof summary === "string" && summary.trim()) this.note(summary, "", ["compacted"]);
		}
		for (const key of Array.isArray(snap.registers) ? snap.registers.slice(0, 20) : []) {
			if (typeof key === "string" && this.state.registers[key]) {
				this.state.registers[key].hits += 1;
				this.state.registers[key].lastUsedAt = now;
			}
		}
		this.mark();
	}

	Recall(query: string, limit = 8, options: RecallOptions = {}): RecallHit[] {
		const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "how", "why", "what", "when", "where", "can", "you", "please", "some", "any"]);
		const tokens = new Set(
			String(query || "")
				.toLowerCase()
				.split(/[^a-z0-9_-]+/)
				.filter((word) => word.length >= 3 && !stop.has(word)),
		);
		if (tokens.size === 0) return [];
		const requested = [...new Set((options.tags || []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
		const aliases = (tag: string) => [tag, tag.replace(/^(project|concept|task|kind):/, "")].filter(Boolean);
		const hits: RecallHit[] = [];
		const queryVector = TokenVector(String(query || ""));
		const add = (Kind: RecallHit["Kind"], Key: string, Text: string, Tags: string[], item: Scored) => {
			const haystack = `${Key} ${Text} ${Tags.join(" ")}`.toLowerCase();
			const present = Tags.map((tag) => String(tag).toLowerCase());
			const matched = requested.filter((tag) => aliases(tag).some((alias) => present.some((value) => value === alias || value.startsWith(`${alias}:`))));
			if (requested.length && (options.mode === "any" ? matched.length === 0 : matched.length !== requested.length)) return;
			const overlap = [...tokens].filter((token) => haystack.includes(token)).length;
			const phrase = String(query || "").trim().toLowerCase();
			const exact = phrase.length >= 4 && haystack.includes(phrase) ? 3 : 0;
			const cosine = Cosine(queryVector, TokenVector(haystack));
			const base = overlap * 2 + exact + cosine * 5 + Math.min(3, score(item) * 0.2) + matched.length * 2;
			if (overlap > 0 || cosine > 0.05 || matched.length) hits.push({ Kind, Key, Text: Text.slice(0, 240), Score: Math.round(base * 10) / 10, Tags: [...new Set(Tags)].slice(0, 12), Matched: matched.length ? matched : undefined });
		};
		for (const [key, meta] of Object.entries(this.state.registers)) add("Register", key, preview(meta.value, 200), meta.tags || [], meta);
		for (const fact of this.state.facts) add("Fact", fact.id, fact.claim, fact.tags, fact);
		for (const episode of this.state.episodes) add("Episode", episode.id, `${episode.summary} ${episode.detail || ""}`, episode.tags, episode);
		for (const technique of this.state.techniques) add("Technique", technique.name, `${technique.description} ${technique.usage} ${technique.command}`, technique.tags, technique);
		return hits.sort((a, b) => b.Score - a.Score).slice(0, Math.max(1, Math.min(20, limit)));
	}

	private quarantineCold(reason: string): void {
		try {
			fs.renameSync(this.coldFile, `${this.coldFile}.corrupt-${reason}-${Date.now()}`);
		} catch {
			// Best effort; never overwrite unreadable cold data blindly.
		}
	}

	private loadCold(): ColdItem[] {
		return WithFileLock(this.coldFile, () => this.loadColdUnsafe());
	}

	private loadColdUnsafe(): ColdItem[] {
		try {
			if (!fs.existsSync(this.coldFile)) return [];
			if (fs.statSync(this.coldFile).size > CAPS.coldBytes) {
				this.quarantineCold("oversize");
				return [];
			}
			const parsed = JSON.parse(fs.readFileSync(this.coldFile, "utf8"));
			if (!Array.isArray(parsed)) throw new Error("cold file is not an array");
			return (parsed as ColdItem[]).slice(-CAPS.cold);
		} catch {
			this.quarantineCold("parse");
			return [];
		}
	}

	private saveCold(items: ColdItem[]): void {
		WithFileLock(this.coldFile, () => {
			const trimmed = MergeCold(this.loadColdUnsafe(), items).slice(-CAPS.cold);
			let text = JSON.stringify(trimmed, null, 2);
			while (trimmed.length && Buffer.byteLength(text, "utf8") > CAPS.coldBytes) {
				trimmed.shift();
				text = JSON.stringify(trimmed, null, 2);
			}
			AtomicWriteText(this.coldFile, text);
		});
	}

	PruneCandidates(options: { ttlDays?: number; maxHits?: number; maxItems?: number } = {}): Array<{ Kind: string; Key: string; Score: number; Reason: string }> {
		const ttlDays = Math.max(1, Number(options.ttlDays ?? 14));
		const maxHits = Math.max(0, Number(options.maxHits ?? 1));
		const cutoff = Date.now() - ttlDays * 86_400_000;
		const protectedPrefixes = ["rule", "associate", "reflect", "meta", "background", "dream", "prune", "plan_"];
		const candidates: Array<{ Kind: string; Key: string; Score: number; Reason: string }> = [];
		const stamp = (item: Scored) => item.lastUsedAt ?? item.lastSeenAt ?? item.createdAt ?? 0;
		const consider = (Kind: string, Key: string, item: Scored & PinMeta) => {
			if (item.pinned) return;
			const at = stamp(item);
			if ((item.hits || 0) > maxHits || at > cutoff || !at) return;
			const ageDays = (Date.now() - at) / 86_400_000;
			candidates.push({ Kind, Key, Score: Math.round(ageDays / ((item.hits || 0) + 1)), Reason: `unused for ${Math.round(ageDays)} days, hits=${item.hits || 0}` });
		};
		for (const [key, meta] of Object.entries(this.state.registers)) {
			if (protectedPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`) || (prefix === "plan_" && key.startsWith(prefix)))) continue;
			consider("Register", key, meta);
		}
		for (const fact of this.state.facts) consider("Fact", fact.id, fact);
		for (const episode of this.state.episodes) consider("Episode", episode.id, episode);
		for (const technique of this.state.techniques) consider("Technique", technique.id, technique);
		for (const path of this.state.paths) consider("Path", path.key, path);
		for (const command of this.state.commands) consider("Command", command.key, command);
		return candidates.sort((a, b) => b.Score - a.Score).slice(0, Math.max(1, Number(options.maxItems ?? 50)));
	}

	Prune(decisions: Record<string, "Prune" | "Keep"> | null = null, maxItems = 50, reason = "PiPrune", ttlDays = 14): ColdItem[] {
		const candidates = this.PruneCandidates({ maxItems: maxItems * 2, ttlDays }).filter((candidate) => decisions?.[candidate.Key] !== "Keep");
		const chosen = candidates.filter((candidate) => decisions === null || decisions[candidate.Key] === "Prune").slice(0, maxItems);
		if (!chosen.length) return [];
		const byKey = new Map(chosen.filter((candidate) => !["rule", "associate", "reflect", "meta", "background", "dream", "prune", "plan_"].some((prefix) => candidate.Key === prefix || candidate.Key.startsWith(`${prefix}.`) || (prefix === "plan_" && candidate.Key.startsWith(prefix)))).map((candidate) => [`${candidate.Kind}|${candidate.Key}`, candidate]));
		const moved: ColdItem[] = [];
		for (const [key, meta] of Object.entries(this.state.registers)) {
			const hit = byKey.get(`Register|${key}`);
			if (hit) { moved.push({ Id: id("cold"), Kind: "Register", Key: key, Data: meta, Reason: hit.Reason, At: Date.now() }); delete this.state.registers[key]; this.removed.add(key); this.markTombstone(key); }
		}
		this.state.facts = this.state.facts.filter((fact) => {
			const hit = byKey.get(`Fact|${fact.id}`);
			if (!hit) return true;
			moved.push({ Id: id("cold"), Kind: "Fact", Key: fact.id, Data: fact, Reason: hit.Reason, At: Date.now() });
			this.removed.add(fact.id); this.removed.add(fact.claim.trim().toLowerCase()); this.markTombstone(fact.id); this.markTombstone(fact.claim.trim().toLowerCase());
			return false;
		});
		this.state.episodes = this.state.episodes.filter((episode) => {
			const hit = byKey.get(`Episode|${episode.id}`);
			if (!hit) return true;
			moved.push({ Id: id("cold"), Kind: "Episode", Key: episode.id, Data: episode, Reason: hit.Reason, At: Date.now() });
			this.removed.add(episode.id); this.removed.add(episode.summary.trim().toLowerCase()); this.markTombstone(episode.id); this.markTombstone(episode.summary.trim().toLowerCase());
			return false;
		});
		this.state.techniques = this.state.techniques.filter((technique) => {
			const hit = byKey.get(`Technique|${technique.id}`);
			if (!hit) return true;
			moved.push({ Id: id("cold"), Kind: "Technique", Key: technique.id, Data: technique, Reason: hit.Reason, At: Date.now() });
			this.removed.add(technique.id); this.removed.add(technique.name); this.markTombstone(technique.id); this.markTombstone(technique.name);
			return false;
		});
		for (const collection of [this.state.paths, this.state.commands]) {
			for (let i = collection.length - 1; i >= 0; i--) {
				const hit = byKey.get(`${collection === this.state.paths ? "Path" : "Command"}|${collection[i].key}`);
				if (!hit) continue;
				moved.push({ Id: id("cold"), Kind: collection === this.state.paths ? "Path" : "Command", Key: collection[i].key, Data: collection[i], Reason: hit.Reason, At: Date.now() });
				this.removed.add(collection[i].key); this.markTombstone(collection[i].key);
				collection.splice(i, 1);
			}
		}
		for (const item of moved) item.Reason = `${reason}: ${item.Reason}`;
		const cold = [...this.loadCold(), ...moved];
		let bytes = JSON.stringify(cold).length;
		while (cold.length > CAPS.cold || bytes > CAPS.coldBytes) {
			cold.shift();
			bytes = JSON.stringify(cold).length;
		}
		this.saveCold(cold);
		this.mark();
		const savedIds = new Set(this.loadCold().map((item) => item.Id));
		return moved.filter((item) => savedIds.has(item.Id));
	}

	Restore(key: string): boolean {
		const cold = this.loadCold();
		const index = cold.findIndex((item) => item.Key === key);
		if (index < 0) return false;
		const item = cold[index];
		delete this.state.tombstones?.[item.Key];
		this.resurrected.add(item.Key);
		this.removed.delete(item.Key);
		const data = item.Data as Record<string, unknown> | undefined;
		const aliases = [
			typeof data?.claim === "string" ? data.claim.trim().toLowerCase() : "",
			typeof data?.summary === "string" ? data.summary.trim().toLowerCase() : "",
			typeof data?.name === "string" ? data.name : "",
		].filter(Boolean);
		for (const alias of aliases) {
			delete this.state.tombstones?.[alias];
			this.resurrected.add(alias);
			this.removed.delete(alias);
		}
		if (item.Kind === "Register" && this.state.registers[item.Key]) return false;
		if (item.Kind === "Fact" && this.state.facts.some((f) => f.id === (item.Data as Fact)?.id)) return false;
		if (item.Kind === "Episode" && this.state.episodes.some((e) => e.id === (item.Data as Episode)?.id)) return false;
		if (item.Kind === "Technique" && this.state.techniques.some((t) => t.id === (item.Data as Technique)?.id)) return false;
		cold.splice(index, 1);
		this.saveCold(cold);
		this.mark();
		if (item.Kind === "Register") this.state.registers[item.Key] = item.Data as RegisterMeta;
		else if (item.Kind === "Fact") this.state.facts.push(item.Data as Fact);
		else if (item.Kind === "Episode") this.state.episodes.push(item.Data as Episode);
		else if (item.Kind === "Technique") this.state.techniques.push(item.Data as Technique);
		else if (item.Kind === "Path") this.state.paths.push(item.Data as Counted);
		else if (item.Kind === "Command") this.state.commands.push(item.Data as Counted);
		return true;
	}

	Pin(key: string, scope = "global"): boolean {
		const target = this.state.registers[key]
			|| this.state.facts.find((item) => item.id === key)
			|| this.state.episodes.find((item) => item.id === key)
			|| this.state.techniques.find((item) => item.id === key)
			|| this.state.paths.find((item) => item.key === key)
			|| this.state.commands.find((item) => item.key === key);
		if (!target) return false;
		target.pinned = true;
		target.pinnedScopes = [...new Set([...(target.pinnedScopes || []), scope])].slice(-16);
		this.mark();
		return true;
	}

	Unpin(key: string): boolean {
		const target = this.state.registers[key]
			|| this.state.facts.find((item) => item.id === key)
			|| this.state.episodes.find((item) => item.id === key)
			|| this.state.techniques.find((item) => item.id === key)
			|| this.state.paths.find((item) => item.key === key)
			|| this.state.commands.find((item) => item.key === key);
		if (!target || !target.pinned) return false;
		delete target.pinned;
		delete target.pinnedScopes;
		this.mark();
		return true;
	}

	ColdRecall(query: string, limit = 5, threshold = 5): { Matches: Array<{ Key: string; Kind: string; Signal: number; Preview: string }>; Promoted: string[] } {
		const tokens = new Set(String(query || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((word) => word.length >= 3));
		if (!tokens.size) return { Matches: [], Promoted: [] };
		const cold = this.loadCold();
		if (!cold.length) return { Matches: [], Promoted: [] };
		const matches: Array<{ Key: string; Kind: string; Signal: number; Preview: string }> = [];
		for (const item of cold) {
			const haystack = JSON.stringify(item.Data || {}).toLowerCase();
			const overlap = [...tokens].filter((token) => haystack.includes(token)).length;
			if (!overlap) continue;
			item.Signal = (item.Signal || 0) + overlap;
			matches.push({ Key: item.Key, Kind: item.Kind, Signal: item.Signal, Preview: preview(item.Data, 160) });
		}
		if (matches.length) this.saveCold(cold);
		const promoted: string[] = [];
		for (const match of matches.filter((item) => item.Signal >= threshold).slice(0, 5)) {
			if (this.Restore(match.Key)) promoted.push(match.Key);
		}
		return { Matches: matches.sort((a, b) => b.Signal - a.Signal).slice(0, limit), Promoted: promoted };
	}

	coldStats(): Record<string, unknown> {
		const cold = this.loadCold();
		return { file: this.coldFile, items: cold.length, bytes: JSON.stringify(cold).length, cap: CAPS.cold };
	}

	ListFacts(limit = 12): Array<Record<string, unknown>> {
		return [...this.state.facts].sort((a, b) => score(b) - score(a)).slice(0, limit).map((f) => ({ id: f.id, claim: f.claim.slice(0, 240), tags: f.tags, hits: f.hits, pinned: Boolean(f.pinned), updatedAt: f.lastUsedAt }));
	}

	ListEpisodes(limit = 12): Array<Record<string, unknown>> {
		return [...this.state.episodes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit).map((e) => ({ id: e.id, summary: e.summary.slice(0, 240), tags: e.tags, hits: e.hits, pinned: Boolean(e.pinned), createdAt: e.createdAt }));
	}

	ListTechniques(limit = 12): Array<Record<string, unknown>> {
		return [...this.state.techniques].sort((a, b) => score(b) - score(a)).slice(0, limit).map((t) => ({ id: t.id, name: t.name, description: t.description.slice(0, 160), hits: t.hits, expose: t.expose, pinned: Boolean(t.pinned) }));
	}

	ListCold(limit = 12): Array<Record<string, unknown>> {
		return this.loadCold().slice(-limit).map((item) => ({ id: item.Id, kind: item.Kind, key: item.Key, reason: item.Reason.slice(0, 120), signal: item.Signal || 0, at: item.At }));
	}

	RecordUsage(event: Omit<UsageEvent, "Id" | "At"> & { At?: number }): void {
		this.state.usage.push({
			Id: id("use"),
			At: event.At ?? Date.now(),
			Tool: String(event.Tool || "unknown").slice(0, 80),
			Action: String(event.Action || "").slice(0, 80),
			DurationMs: Math.max(0, Number(event.DurationMs) || 0),
			Success: Boolean(event.Success),
			ErrorCode: event.ErrorCode ? String(event.ErrorCode).slice(0, 120) : undefined,
			InputBytes: Math.max(0, Number(event.InputBytes) || 0),
			OutputBytes: Math.max(0, Number(event.OutputBytes) || 0),
			Model: event.Model ? String(event.Model).slice(0, 120) : undefined,
			Trigger: event.Trigger ? String(event.Trigger).slice(0, 240) : undefined,
			Meta: event.Meta ? JSON.parse(JSON.stringify(event.Meta)) as Record<string, unknown> : undefined,
		});
		this.mark();
	}

	UsageStats(): Record<string, unknown> {
		const rows = this.state.usage;
		const group = (key: (row: UsageEvent) => string) => {
			const map = new Map<string, UsageEvent[]>();
			for (const row of rows) {
				const name = key(row) || "(none)";
				map.set(name, [...(map.get(name) || []), row]);
			}
			return [...map.entries()].map(([Name, items]) => {
				const durations = items.map((item) => item.DurationMs).sort((a, b) => a - b);
				return {
					Name,
					Calls: items.length,
					Success: items.filter((item) => item.Success).length,
					Errors: items.filter((item) => !item.Success).length,
					AvgMs: Math.round(durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length)),
					P95Ms: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] || 0,
					InputBytes: items.reduce((a, b) => a + b.InputBytes, 0),
					OutputBytes: items.reduce((a, b) => a + b.OutputBytes, 0),
					FirstAt: Math.min(...items.map((item) => item.At)),
					LastAt: Math.max(...items.map((item) => item.At)),
				};
			}).sort((a, b) => b.Calls - a.Calls);
		};
		return {
			Total: rows.length,
			Cap: CAPS.usage,
			FirstAt: rows.length ? Math.min(...rows.map((row) => row.At)) : null,
			LastAt: rows.length ? Math.max(...rows.map((row) => row.At)) : null,
			ByTool: group((row) => row.Tool),
			ByAction: group((row) => `${row.Tool}.${row.Action}`),
			ByModel: group((row) => row.Model || "unknown"),
			ByTrigger: group((row) => row.Trigger || "none"),
		};
	}

	UsageRows(limit = 200): UsageEvent[] {
		return this.state.usage.slice(-Math.max(1, Math.min(CAPS.usage, limit)));
	}

	ExportUsage(format: string, limit = 200): unknown {
		const rows = this.UsageRows(limit);
		if (format === "jsonl") return rows.map((row) => JSON.stringify(row)).join("\n");
		if (format === "eval") {
			return rows.map((row) => ({
				case_id: row.Id,
				timestamp: new Date(row.At).toISOString(),
				tool: row.Tool,
				action: row.Action,
				success: row.Success,
				duration_ms: row.DurationMs,
				input_bytes: row.InputBytes,
				output_bytes: row.OutputBytes,
				model: row.Model,
				trigger: row.Trigger,
				metadata: row.Meta || {},
			}));
		}
		if (format === "langsmith") {
			return rows.map((row) => ({
				id: row.Id,
				name: `${row.Tool}.${row.Action || "call"}`,
				run_type: "tool",
				start_time: new Date(row.At).toISOString(),
				end_time: new Date(row.At + row.DurationMs).toISOString(),
				inputs: { bytes: row.InputBytes, trigger: row.Trigger },
				outputs: { bytes: row.OutputBytes },
				extra: { model: row.Model, metadata: row.Meta || {} },
				tags: [row.Tool, row.Success ? "success" : "error"],
				error: row.ErrorCode || null,
			}));
		}
		if (format === "langfuse") {
			return rows.map((row) => ({
				id: row.Id,
				name: `${row.Tool}.${row.Action || "call"}`,
				type: "TOOL",
				startTime: new Date(row.At).toISOString(),
				endTime: new Date(row.At + row.DurationMs).toISOString(),
				input: { bytes: row.InputBytes, trigger: row.Trigger },
				output: { bytes: row.OutputBytes },
				metadata: { model: row.Model, success: row.Success, ...row.Meta },
				level: row.Success ? "DEFAULT" : "ERROR",
				statusMessage: row.ErrorCode || "",
			}));
		}
		if (format === "otel") {
			return rows.map((row) => ({
				traceId: createHash("sha256").update(String(row.At)).digest("hex").slice(0, 32),
				spanId: createHash("sha1").update(row.Id).digest("hex").slice(0, 16),
				name: `${row.Tool}.${row.Action || "call"}`,
				kind: 2,
				startTimeUnixNano: row.At * 1_000_000,
				endTimeUnixNano: (row.At + row.DurationMs) * 1_000_000,
				attributes: {
					"tool.name": row.Tool,
					"tool.action": row.Action,
					"tool.success": row.Success,
					"tool.input_bytes": row.InputBytes,
					"tool.output_bytes": row.OutputBytes,
					"gen_ai.model": row.Model || "unknown",
					"trigger": row.Trigger || "none",
				},
				status: { code: row.Success ? 1 : 2, message: row.ErrorCode || "" },
			}));
		}
		return rows;
	}

	ClearUsage(): number {
		const count = this.state.usage.length;
		this.state.usage = [];
		this.mark();
		return count;
	}

	listConflicts(): MergeConflict[] {
		return [...this.state.conflicts].slice(-20);
	}

	stats(): Record<string, unknown> {
		return {
			file: this.filePath,
			registers: Object.keys(this.state.registers).length,
			registerBytes: Object.values(this.state.registers).reduce((n, m) => n + JSON.stringify(m.value ?? null).length, 0),
			facts: this.state.facts.length,
			episodes: this.state.episodes.length,
			techniques: this.state.techniques.length,
			paths: this.state.paths.length,
			commands: this.state.commands.length,
			usageRows: this.state.usage.length,
			conflicts: this.state.conflicts.length,
			dirty: this.dirty,
		};
	}
}
