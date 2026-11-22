import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPS, MnemonicStore, parsePath } from "../src/store.ts";

type AnyRecord = Record<string, unknown>;

function tempStore(): { store: MnemonicStore; file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-test-"));
	const file = path.join(dir, "store.json");
	return { store: new MnemonicStore(file), file, dir };
}

test("parsePath supports dots, indices, and quoted keys", () => {
	assert.deepEqual(parsePath("hosts.dev[0].port"), ["hosts", "dev", 0, "port"]);
	assert.deepEqual(parsePath('cfg["api key"].url'), ["cfg", "api key", "url"]);
});

test("registers support nested paths and hit counts", () => {
	const { store } = tempStore();
	store.set("hosts.dev[0].port", 8787);
	assert.equal(store.get("hosts.dev[0].port"), 8787);
	store.set("hosts.dev[0].name", "proxy");
	assert.deepEqual(store.peek("hosts.dev"), [{ port: 8787, name: "proxy" }]);
	assert.equal(store.list()[0].hits, 1);
	assert.equal(store.delete("hosts.dev[0].name"), true);
	assert.deepEqual(store.peek("hosts.dev"), [{ port: 8787 }]);
});

test("facts dedupe and notes persist", () => {
	const { store, file } = tempStore();
	store.learn("Xorg clean shutdown means lightdm restart, not crash", ["display"], 0.9, "investigation");
	store.learn("  Xorg clean shutdown means lightdm restart, not crash ", ["display"]);
	store.note("Fixed pi-mnemonic caps", "bounded stores", ["memory"]);
	assert.equal(store.stats().facts, 1);
	assert.equal(store.stats().episodes, 1);
	store.flush();
	const reloaded = new MnemonicStore(file);
	assert.equal(reloaded.stats().facts, 1);
	assert.equal(reloaded.hot().facts[0].includes("Xorg"), true);
});

test("techniques materialize scripts and expose metadata", () => {
	const { store } = tempStore();
	const technique = store.techniqueAdd({
		name: "scan-repo",
		command: "rg -n {{Pattern}} {{Path}}",
		description: "Targeted repo search",
		params: ["Pattern", "Path"],
		expose: true,
	});
	store.techniqueGet("scan-repo");
	assert.equal(technique.hits, 1);
	assert.equal(store.allTechniques()[0].expose, true);
	const script = store.techniqueScript("scan-repo", "rg -n TODO src");
	assert.ok(fs.existsSync(script));
	assert.match(fs.readFileSync(script, "utf8"), /set -euo pipefail/);
});

test("hot commands are redacted and bounded", () => {
	const { store } = tempStore();
	store.commandHit("curl --token abc123 https://example.com");
	store.commandHit("API_KEY=secret value run.sh");
	const commands = store.hot().commands.join("\n");
	assert.doesNotMatch(commands, /abc123|secret value/);
	assert.match(commands, /<redacted>/);
	store.commandHit("curl --token=abc123 https://x");
	store.commandHit("AWS_SECRET_ACCESS_KEY=abc run.sh");
	store.commandHit("Authorization: Bearer abc.def");
	const more = store.hot().commands.join("\n");
	assert.doesNotMatch(more, /abc123|AWS_SECRET_ACCESS_KEY=abc|Bearer abc\.def/);
	for (let i = 0; i < CAPS.commands + 50; i++) store.commandHit(`cmd ${i}`);
	store.flush();
	assert.ok(Number(store.stats().commands) <= CAPS.commands);
});

test("10k writes prune to declared caps", () => {
	const { store } = tempStore();
	for (let i = 0; i < 10_000; i++) store.set(`key${i}`, { i });
	for (let i = 0; i < 500; i++) store.learn(`fact ${i}`);
	for (let i = 0; i < 200; i++) store.note(`episode ${i}`);
	store.flush();
	const stats = store.stats();
	assert.equal(stats.registers, CAPS.registers);
	assert.equal(stats.facts, CAPS.facts);
	assert.equal(stats.episodes, CAPS.episodes);
	assert.ok(Number(stats.registerBytes) <= CAPS.registerBytes);
});

test("Recall ranks associated techniques by token overlap", () => {
	const { store } = tempStore();
	store.learn("Xvfb GTK tests need GLX disabled on this NVIDIA host", ["xvfb", "gtk", "nvidia"]);
	store.learn("Headroom proxy caches model weights in RAM", ["headroom", "memory"]);
	store.techniqueAdd({ name: "safe_xvfb", command: "xvfb-run -a -s '-extension GLX' " + "{{Command}}", description: "Private display for GTK tests", tags: ["xvfb", "gtk"] });
	const hits = store.Recall("GTK xvfb GLX crash", 5);
	assert.ok(hits.length >= 2);
	assert.equal(hits[0].Kind, "Fact");
	assert.match(hits[0].Text, /Xvfb/);
});

test("prune moves stale items to bounded cold storage and restores them", () => {
	const { store, file } = tempStore();
	store.set("stale_key", "old");
	store.flush();
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	const old = Date.now() - 30 * 86_400_000;
	raw.registers.stale_key.createdAt = old;
	raw.registers.stale_key.lastUsedAt = old;
	fs.writeFileSync(file, JSON.stringify(raw));
	const reloaded = new MnemonicStore(file);
	const candidates = reloaded.PruneCandidates({ ttlDays: 14 });
	assert.ok(candidates.some((candidate) => candidate.Key === "stale_key"));
	const moved = reloaded.Prune(null, 10, "test");
	assert.ok(moved.some((item) => item.Key === "stale_key"));
	assert.equal(reloaded.peek("stale_key"), undefined);
	assert.ok(Number(reloaded.coldStats().items) >= 1);
	assert.equal(reloaded.Restore("stale_key"), true);
	assert.equal(reloaded.peek("stale_key"), "old");
});

test("pinned items avoid pruning and repeated cold recall promotes", () => {
	const { store, file } = tempStore();
	store.set("pinned_value", "pinned-data");
	store.Pin("pinned_value", "project:/home/user");
	store.flush();
	const rawAfter = JSON.parse(fs.readFileSync(file, "utf8"));
	const old = Date.now() - 30 * 86_400_000;
	rawAfter.registers.pinned_value.createdAt = old;
	rawAfter.registers.pinned_value.lastUsedAt = old;
	fs.writeFileSync(file, JSON.stringify(rawAfter));
	const reloaded = new MnemonicStore(file);
	assert.equal(reloaded.PruneCandidates({ ttlDays: 14 }).some((c) => c.Key === "pinned_value"), false);

	store.set("cold_value", "cold-data");
	store.flush();
	const raw2 = JSON.parse(fs.readFileSync(file, "utf8"));
	raw2.registers.cold_value.createdAt = old;
	raw2.registers.cold_value.lastUsedAt = old;
	fs.writeFileSync(file, JSON.stringify(raw2));
	const reloaded2 = new MnemonicStore(file);
	reloaded2.Prune(null, 10, "test");
	const recalled = reloaded2.ColdRecall("cold-data", 5, 1);
	assert.ok(recalled.Promoted.includes("cold_value"));
	assert.equal(reloaded2.peek("cold_value"), "cold-data");
});

test("register paths reject prototype keys and huge indices", () => {
	const { store } = tempStore();
	assert.throws(() => store.set("__proto__.polluted", "x"), /Reserved/);
	assert.throws(() => store.set("constructor.prototype.x", "x"), /Reserved/);
	assert.throws(() => store.set("a[2000]", "x"), /Array index/);
	assert.equal(({} as AnyRecord).polluted, undefined);
});

test("corrupt store is quarantined and replaced", () => {
	const { store, file } = tempStore();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "not json");
	const reloaded = new MnemonicStore(file);
	assert.equal(reloaded.stats().registers, 0);
	assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("store.json.corrupt-")));
});
