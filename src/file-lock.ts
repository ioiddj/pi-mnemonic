/**
 * Bounded cooperative file locking plus atomic replace and locked RMW helpers.
 * Public APIs are generic over the locked callback's return type.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const active = new Set<string>();

export function FileStamp(file: string): string {
	try {
		const target = path.resolve(file);
		const stat = fs.statSync(target);
		const base = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return base;
		const hash = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
		return `${base}:${hash}`;
	} catch {
		return "missing";
	}
}
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_STALE_MS = 30_000;
const RETRY_MS = 8;

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: unknown): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

function sweepOldTemps(target: string): void {
	const dir = path.dirname(target);
	const prefix = `${path.basename(target)}.${process.pid}.`;
	try {
		for (const name of fs.readdirSync(dir)) {
			if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
			const file = path.join(dir, name);
			try {
				if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file);
			} catch {
				// Best effort; another writer may have already cleaned it.
			}
		}
	} catch {
		// No directory or no permission; the lock itself still works.
	}
}

/** Bounded cross-process lock for a shared file. Reentrant inside one process. */
export function WithFileLock<T>(file: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS): T {
	const target = path.resolve(file);
	const lock = `${target}.lock`;
	if (active.has(lock)) return fn();
	fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + Math.max(1, Math.min(10_000, timeoutMs));
	const safeStaleMs = Math.max(5000, staleMs);
	let handle: number | undefined;
	let acquired = false;
	while (Date.now() < deadline) {
		try {
			handle = fs.openSync(lock, "wx", 0o600);
			fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now(), token: randomUUID() }));
			acquired = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const stat = fs.statSync(lock);
				const text = fs.readFileSync(lock, "utf8");
				let record: Record<string, unknown> = {};
				try {
					record = JSON.parse(text) as Record<string, unknown>;
				} catch {
					// An empty or truncated lock is reclaimable when old and unowned.
				}
				if (Date.now() - stat.mtimeMs > safeStaleMs && !pidAlive(record.pid)) {
					const again = fs.readFileSync(lock, "utf8");
					const againStat = fs.statSync(lock);
					if (again === text && againStat.mtimeMs === stat.mtimeMs) fs.unlinkSync(lock);
				}
			} catch {
				// A lock that vanished or is unreadable will be retried until the deadline.
			}
			sleep(RETRY_MS);
		}
	}
	if (!acquired) throw new Error(`Timed out acquiring file lock: ${lock}`);
	active.add(lock);
	sweepOldTemps(target);
	try {
		return fn();
	} finally {
		active.delete(lock);
		try {
			if (handle !== undefined) fs.closeSync(handle);
		} catch {
			// Best effort; the lock file is the visible owner record.
		}
		try {
			fs.unlinkSync(lock);
		} catch {
			// Best effort; stale locks are reclaimed above.
		}
	}
}

/** Write via unique temp file + rename so readers never see partial JSON. */
export function AtomicWriteText(file: string, text: string, mode = 0o600): void {
	const target = path.resolve(file);
	try {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${target}`);
		if (stat.nlink > 1) throw new Error(`Refusing to write to a hardlinked file: ${target}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		fs.writeFileSync(tmp, text, { mode, flag: "wx" });
		fs.renameSync(tmp, target);
	} catch (error) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// The temp file may already have been renamed.
		}
		throw error;
	}
}

/** Locked read-modify-write for small text/markdown files. */
export function AtomicUpdateText(file: string, update: (existing: string) => string, fallback = "", maxBytes = 200_000): boolean {
	return WithFileLock(file, () => {
		const target = path.resolve(file);
		for (let attempt = 0; attempt < 3; attempt++) {
			let existing = fallback;
			const before = FileStamp(target);
			try {
				if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${target}`);
				if (fs.statSync(target).size > maxBytes) throw new Error(`Shared file is too large to update safely: ${target}`);
				existing = fs.readFileSync(target, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const next = update(existing);
			if (next === existing) return false;
			if (Buffer.byteLength(next, "utf8") > maxBytes) throw new Error(`Shared file would exceed ${maxBytes} bytes: ${target}`);
			if (FileStamp(target) !== before) continue;
			AtomicWriteText(target, next);
			return true;
		}
		throw new Error(`Shared file changed concurrently: ${target}`);
	});
}
