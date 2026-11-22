import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildDreamPanel, CreateDreamPanel } from "../src/dream-panel.ts";

const config = {
	Enabled: false,
	IdleMs: 15_000,
	Depth: 10,
	SweepKb: 512,
	PromptKeys: ["PiDream", "PiTriggerDecision"],
	PromptSource: { PiDream: "default", PiTriggerDecision: "card" },
};

test("dream panel shows opt-in state and controls", () => {
	const text = BuildDreamPanel(config, 0, undefined, 80).join("\n");
	assert.match(text, /DISABLED/);
	assert.match(text, /idle time/);
	assert.match(text, /depth/);
	assert.match(text, /sweep/);
	assert.match(text, /PiDream/);
});

test("dream panel edits local state and returns save result", () => {
	let result: any;
	let renders = 0;
	const panel = CreateDreamPanel(config, { requestRender: () => { renders++; } }, undefined, undefined, (value) => { result = value; });
	panel.handleInput(" ");
	panel.handleInput("+");
	panel.handleInput("]");
	panel.handleInput("}");
	panel.handleInput("\u001b");
	assert.equal(result.Save, false);
	assert.equal(result.Enabled, true);

	const panel2 = CreateDreamPanel(config, { requestRender: () => {} }, undefined, undefined, (value) => { result = value; });
	panel2.handleInput(" ");
	panel2.handleInput("\r");
	assert.equal(result.Save, true);
	assert.equal(result.Enabled, true);
	assert.ok(renders > 0);
});
