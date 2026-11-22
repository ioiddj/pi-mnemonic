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
	const links = WarmMarkdownLinks(store, fs.readFileSync(a, "utf8"), a, 2);
	assert.ok(links.some((link) => link.Kind === "file" && link.Target.endsWith("b.md")));
	assert.ok(links.some((link) => link.Kind === "url" && link.Target.includes("example.com")));
	assert.ok(store.list("link_").length >= 2);
});

test("weave adds a bounded Related section without duplicating links", () => {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, "b.md"), "# B\n");
	fs.writeFileSync(path.join(dir, "c.md"), "# C\n");
	const a = path.join(dir, "a.md");
	fs.writeFileSync(a, "# A\n");
	const first = WeaveRelatedLinks(a, 5);
	assert.equal(first.added.length, 2);
	const second = WeaveRelatedLinks(a, 5);
	assert.equal(second.added.length, 0);
	assert.match(fs.readFileSync(a, "utf8"), /## Related/);
});
