import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROMPTS } from "../src/prompt-defaults.ts";
import { PromptKeys, PromptSource, PromptText } from "../src/prompt-cards.ts";

test("all default prompt keys have cards or defaults", () => {
	for (const key of Object.keys(DEFAULT_PROMPTS)) {
		assert.ok(PromptKeys().includes(key));
		assert.ok(PromptText(key).length > 20);
		assert.ok(["card", "default"].includes(PromptSource(key)));
	}
});

test("cards are read from the dot config directory", () => {
	assert.equal(PromptSource("PiReflect"), "card");
	assert.match(PromptText("PiReflect"), /JSON/);
});
