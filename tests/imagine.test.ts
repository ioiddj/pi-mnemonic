import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenerateCounterfactuals } from "../src/imagine.ts";
import { MnemonicStore } from "../src/store.ts";

test("GenerateCounterfactuals maps failure markers to lessons", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-imagine-"));
	const store = new MnemonicStore(path.join(dir, "store.json"));
	store.learn("The Xvfb test hit a timeout before completion", ["xvfb"], 0.8, "test");
	const speculative = GenerateCounterfactuals(store, "xvfb timeout", 3, false);
	assert.ok(speculative.length > 0);
	assert.match(speculative[0].Lesson, /checkpoint|bounded|timeout/i);
	assert.equal(speculative[0].Hypothesis, undefined);

	const rigorous = GenerateCounterfactuals(store, "xvfb timeout", 3, true);
	assert.ok(rigorous[0].Hypothesis);
	assert.ok(rigorous[0].Experiment);
	assert.ok(rigorous[0].Success);
});
