import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildRegisterPanel, CreateRegisterBrowser } from "../src/browser.ts";
import { MnemonicStore } from "../src/store.ts";

function tempStore(): MnemonicStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-browser-"));
	return new MnemonicStore(path.join(dir, "store.json"));
}

test("register panel shows local registers and conflict status", () => {
	const store = tempStore();
	store.set("hosts.dev.port", 8787);
	const lines = BuildRegisterPanel(store, { Detected: true, Mode: "coexist" }, "Registers", 80, undefined, 0);
	const text = lines.join("\n");
	assert.match(text, /hosts/);
	assert.match(text, /engram detected/);
});

test("register browser switches views on number keys", () => {
	const store = tempStore();
	let renders = 0;
	const browser = CreateRegisterBrowser(store, { Detected: false, Mode: "coexist" }, { requestRender: () => { renders++; } }, undefined, undefined, () => {});
	assert.match(browser.render(80).join("\n"), /view Registers/);
	browser.handleInput("5");
	assert.match(browser.render(80).join("\n"), /cold storage empty/);
	assert.ok(renders > 0);
});
