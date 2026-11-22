import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicUpdateText, AtomicWriteText, WithFileLock } from "../src/file-lock.ts";

function tempFile(name = "shared.txt"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-lock-"));
	return path.join(dir, name);
}

test("file lock is reentrant and removes its lock file", () => {
	const file = tempFile();
	const seen = WithFileLock(file, () => WithFileLock(file, () => "nested"));
	assert.equal(seen, "nested");
	assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("atomic update is a locked read-modify-write", () => {
	const file = tempFile();
	AtomicWriteText(file, "first\n");
	AtomicUpdateText(file, (text) => `${text}second\n`);
	AtomicUpdateText(file, (text) => `${text}third\n`);
	assert.equal(fs.readFileSync(file, "utf8"), "first\nsecond\nthird\n");
	assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")).length, 0);
});

test("atomic writes refuse hardlinked targets", () => {
	const file = tempFile();
	AtomicWriteText(file, "original");
	fs.linkSync(file, `${file}.hardlink`);
	assert.throws(() => AtomicWriteText(file, "replacement"), /hardlinked/);
	assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("stale lock is reclaimed and a fresh lock times out", () => {
	const stale = tempFile("stale.txt");
	fs.writeFileSync(`${stale}.lock`, JSON.stringify({ pid: 999_999, at: Date.now() - 60_000 }));
	const old = Date.now() - 60_000;
	fs.utimesSync(`${stale}.lock`, new Date(old), new Date(old));
	WithFileLock(stale, () => assert.equal(fs.existsSync(`${stale}.lock`), true), 50);

	const empty = tempFile("empty.txt");
	fs.writeFileSync(`${empty}.lock`, "");
	fs.utimesSync(`${empty}.lock`, new Date(old), new Date(old));
	WithFileLock(empty, () => assert.equal(fs.existsSync(`${empty}.lock`), true), 50);

	const fresh = tempFile("fresh.txt");
	fs.writeFileSync(`${fresh}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
	assert.throws(() => WithFileLock(fresh, () => "never", 20), /Timed out acquiring file lock/);
	fs.unlinkSync(`${fresh}.lock`);
});
