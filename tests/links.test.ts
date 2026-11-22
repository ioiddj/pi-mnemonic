import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WarmMarkdownLinks, WeaveRelatedLinks } from "../src/links.ts";
import { MnemonicStore } from "../src/store.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-links-"));
}

test("warms local and remote markdown links with bounded depth", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "b.md"), "# B notes\n\nLocal target body.\n");
	fs.writeFileSync(path.join(dir, "c.md"), "# C notes\n\nNeighbor.\n");
	const a = path.join(dir, "a.md");
	fs.writeFileSync(a, "# Index\n\nSee [B](b.md) and [docs](https://example.com/docs).\n");
	const store = new MnemonicStore(path.join(dir, "store.json"));
	const links = WarmMarkdownLinks(store, fs.readFileSync(a, "utf8"), a, 2, dir);
	assert.ok(links.some((link) => link.Kind === "file" && link.Target.endsWith("b.md")));
	assert.ok(links.some((link) => link.Kind === "url" && link.Target.includes("example.com")));
	assert.ok(store.list("link_").length >= 2);
});

test("warms source files and directories as bounded path hints", () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "tool.ts"), "export const answer = 42;\n");
	const a = path.join(dir, "index.md");
	fs.writeFileSync(a, "[tool](src/tool.ts) [source dir](src) [remote](https://example.com/x)\n");
	const store = new MnemonicStore(path.join(dir, "store.json"));
	const links = WarmMarkdownLinks(store, fs.readFileSync(a, "utf8"), a, 1, [dir]);
	assert.ok(links.some((link) => link.Kind === "file" && link.Target.endsWith("tool.ts")));
	assert.ok(links.some((link) => link.Preview.startsWith("Local directory:")));
	assert.ok(links.some((link) => link.Kind === "url"));
});

test("remote URL credentials are redacted before caching", () => {
	const dir = tempDir();
	const a = path.join(dir, "index.md");
	fs.writeFileSync(a, "[remote](https://user:secret@example.com/x)\n");
	const store = new MnemonicStore(path.join(dir, "store.json"));
	const links = WarmMarkdownLinks(store, fs.readFileSync(a, "utf8"), a, 0, dir);
	assert.equal(links.length, 1);
	assert.doesNotMatch(links[0].Target, /secret/);
	assert.match(links[0].Target, /<redacted-userinfo>@example\.com/);
});

test("weave adds a bounded Related section without duplicating links", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "b.md"), "# B\n");
	fs.writeFileSync(path.join(dir, "c.md"), "# C\n");
	const a = path.join(dir, "a.md");
	fs.writeFileSync(a, "# A\n");
	const first = WeaveRelatedLinks(a, 5, dir);
	assert.equal(first.added.length, 2);
	const second = WeaveRelatedLinks(a, 5, dir);
	assert.equal(second.added.length, 0);
	assert.match(fs.readFileSync(a, "utf8"), /## Related/);
});
