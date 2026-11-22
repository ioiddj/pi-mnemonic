import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptStructured } from "../src/intelligence.ts";

function ctxWith(text: string) {
	return {
		model: { id: "test" },
		modelRegistry: {
			complete: async () => ({ content: [{ type: "text", text }] }),
		},
	};
}

test("PromptStructured parses a JSON object from model text", async () => {
	const result = await PromptStructured(ctxWith("noise {\"Fire\":true} tail"), "system", "prompt");
	assert.deepEqual(result, { Fire: true });
});

test("PromptStructured returns undefined for malformed JSON", async () => {
	assert.equal(await PromptStructured(ctxWith("no json here"), "system", "prompt"), undefined);
});

test("PromptStructured returns undefined without a model", async () => {
	assert.equal(await PromptStructured({}, "system", "prompt"), undefined);
});
