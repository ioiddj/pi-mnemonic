import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mnemonic-ext-"));
process.env.XDG_STATE_HOME = temp;
process.env.PI_CODING_AGENT_DIR = temp;
process.env.PI_MNEMONIC_SKILLS_DIR = path.join(temp, "skills");

const { default: PiMnemonic } = await import("../index.ts");

function MockPi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		appendEntry: () => {},
		sendMessage: () => {},
		events: { emit: () => {} },
	};
	return { pi, tools, commands, handlers };
}

test("registers PascalCase tools and lowercase kebab commands", () => {
	const { pi, tools, commands, handlers } = MockPi();
	PiMnemonic(pi);
	for (const name of [
		"PiMnemonicHelp", "PiMnemonicSet", "PiMnemonicGet", "PiMnemonicList", "PiMnemonicDelete",
		"PiMnemonicLearn", "PiMnemonicNote", "PiMnemonicRender", "PiTechnique", "PiMnemonicWarm", "PiMnemonicRecall", "PiMnemonicCodify", "PiMnemonicLink",
		"PiAssociate", "PiDream", "PiPlan", "PiImagine", "PiSimulate", "PiReflect", "PiObserve",
		"PiPredict", "PiRiskAssessment", "PiAssessment", "PiQuantify", "PiModel", "PiHypothesis", "PiExperiment", "PiPrune", "PiCharter", "PiPrompt", "PiStats", "PiMnemonicStats",
	]) {
		assert.ok(tools.has(name), `missing tool ${name}`);
	}
	for (const name of ["pi-mnemonic-help", "pi-mnemonic-status", "pi-mnemonic-warm"]) {
		assert.ok(commands.has(name), `missing command ${name}`);
	}
	for (const event of ["session_start", "before_agent_start", "tool_call", "turn_end", "agent_end", "agent_settled", "session_before_compact", "session_shutdown"]) {
		assert.ok(handlers.has(event), `missing handler ${event}`);
	}
});

test("injects a bounded lowercase system-prompt section", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiMnemonicSet").execute("0", { Key: "rule.safe_xvfb", Value: "Disable GLX on private Xvfb" }, undefined, undefined, ctx);
	const event: any = { messageType: "user", prompt: "xvfb GLX tests", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	const section = event.systemPromptOptions.sections["pi-mnemonic"];
	assert.match(section, /^Cached environment memory/);
	assert.doesNotMatch(section, /<pi-mnemonic>/);
	assert.ok(section.length <= 4000);
	assert.match(section, /PiMnemonicGet/);
	assert.ok("pi-mnemonic-recall" in event.systemPromptOptions.sections);
	assert.ok("pi-mnemonic-links" in event.systemPromptOptions.sections);
	assert.ok("pi-mnemonic-associate" in event.systemPromptOptions.sections);
	assert.ok("pi-mnemonic-reflect" in event.systemPromptOptions.sections);
	event.systemPromptOptions.contextFiles = [{ path: path.join(temp, "AGENTS.md"), content: "Rule: {{rule.safe_xvfb}} and {{secret:API_KEY}}" }];
	await handlers.get("before_agent_start")(event, ctx);
	assert.match(event.systemPromptOptions.contextFiles[0].content, /Disable GLX on private Xvfb/);
	assert.match(event.systemPromptOptions.contextFiles[0].content, /\{\{secret:API_KEY\}\}/);
});

test("Codify writes a SKILL.md and generates a tool", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const codify = tools.get("PiMnemonicCodify");
	await codify.execute("1", { Kind: "Skill", Name: "safe-xvfb", Summary: "Run GTK tests on private Xvfb with GLX disabled", Detail: "Use xvfb-run -a -s '-extension GLX'.", Tags: ["xvfb", "gtk"] }, undefined, undefined, ctx);
	const skill = path.join(temp, "skills", "safe-xvfb", "SKILL.md");
	assert.ok(fs.existsSync(skill));
	assert.match(fs.readFileSync(skill, "utf8"), /^name: safe-xvfb/m);
	await codify.execute("2", { Kind: "Tool", Name: "repo-scan", Summary: "Targeted rg search", Command: "rg -n {{Pattern}} {{Path}}", Params: ["Pattern", "Path"] }, undefined, undefined, ctx);
	assert.ok(tools.has("PiTechniqueRepoScan"));
	const recalled = await tools.get("PiMnemonicRecall").execute("3", { Query: "private Xvfb GLX disabled" }, undefined, undefined, ctx);
	assert.ok(recalled.details.hits.length > 0);
});

test("Codify AgentRule writes an interpolated AGENTS.md token", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiMnemonicCodify").execute("1", { Kind: "AgentRule", Name: "safe-xvfb", Summary: "Disable GLX on private Xvfb" }, undefined, undefined, ctx);
	const agents = fs.readFileSync(path.join(temp, "AGENTS.md"), "utf8");
	assert.match(agents, /\{\{rule\.safe_xvfb\}\}/);
	const event: any = { messageType: "user", prompt: "test", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.match(event.systemPromptOptions.sections["pi-mnemonic"], /Disable GLX on private Xvfb/);
});

test("new cognitive tools store plans and counterfactuals", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiAssociate").execute("1", { Action: "Off" }, undefined, undefined, ctx);
	const off = await tools.get("PiAssociate").execute("2", { Action: "Status" }, undefined, undefined, ctx);
	assert.match(off.content[0].text, /false/);
	await tools.get("PiAssociate").execute("3", { Action: "On" }, undefined, undefined, ctx);
	const plan = await tools.get("PiPlan").execute("4", { Goal: "Migrate launcher tests to private Xvfb", Steps: ["add wrapper", "run tests"] }, undefined, undefined, ctx);
	assert.match(plan.content[0].text, /plan_/);
	await tools.get("PiMnemonicLearn").execute("5", { Claim: "Timeout happened before the Xvfb test finished", Tags: ["xvfb"] }, undefined, undefined, ctx);
	const imagined = await tools.get("PiImagine").execute("6", { Focus: "xvfb timeout", Limit: 2 }, undefined, undefined, ctx);
	assert.ok(imagined.details.Scenarios.length > 0);
	const simulated = await tools.get("PiSimulate").execute("7", { Focus: "xvfb timeout", Limit: 2 }, undefined, undefined, ctx);
	assert.ok(simulated.details.Scenarios[0].Hypothesis);
	assert.ok(simulated.structuredContent.Scenarios);
	const dream = await tools.get("PiDream").execute("8", { Action: "Status" }, undefined, undefined, ctx);
	assert.ok(dream.content[0].text.length > 0);
});

test("PiReflect injects steering on manual run", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }) };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const reflected = await tools.get("PiReflect").execute("1", { Action: "Run", Focus: "Are we going in circles?", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(reflected.structuredContent.Guidance);
	assert.ok(reflected.structuredContent.InjectedPrompt);
	const event: any = { messageType: "user", prompt: "continue", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.match(event.systemPromptOptions.sections["pi-mnemonic-reflect"], /Step back:/);
});

test("dangerous operator settings require real confirmation", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	let confirmResult = false;
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => confirmResult } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const denied = await tools.get("PiCharter").execute("1", { Action: "Disable" }, undefined, undefined, ctx);
	assert.equal(denied.isError, true);
	confirmResult = true;
	const allowed = await tools.get("PiCharter").execute("2", { Action: "Disable" }, undefined, undefined, ctx);
	assert.equal(allowed.isError, undefined);
});

test("charter and pin tokens are injected into context files", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }), ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiCharter").execute("0", { Action: "Enable", Mode: "trigger" }, undefined, undefined, ctx);
	await tools.get("PiMnemonicSet").execute("1", { Key: "pinned_value", Value: "PINNED" }, undefined, undefined, ctx);
	const event: any = { messageType: "user", prompt: "hello", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [{ path: path.join(temp, "AGENTS.md"), content: "Use {{pinned_value!important}}." }] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.equal(event.systemPromptOptions.sections["pi-mnemonic-charter"], "");
	assert.match(event.systemPromptOptions.contextFiles[0].content, /PINNED/);
	const sanctioned: any = { messageType: "user", prompt: "Check this sanctioned individual against OFAC", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(sanctioned, ctx);
	assert.match(sanctioned.systemPromptOptions.sections["pi-mnemonic-charter"], /Operating charter/);
});

test("quantitative meta tools return grounded structured output", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true }, getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 82 }) };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiMnemonicLearn").execute("1", { Claim: "The last run timed out after repeated Xvfb attempts", Tags: ["xvfb"] }, undefined, undefined, ctx);
	const prediction = await tools.get("PiPredict").execute("2", { Focus: "xvfb timeout", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(prediction.structuredContent.Forecast);
	const risk = await tools.get("PiAssessment").execute("3", { Focus: "xvfb timeout", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(risk.structuredContent.RiskScore >= 0);
	const model = await tools.get("PiModel").execute("4", { Focus: "xvfb timeout", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(model.structuredContent.Formula);
	const hypothesis = await tools.get("PiHypothesis").execute("5", { Focus: "xvfb timeout", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(hypothesis.structuredContent.Falsifier);
	const experiment = await tools.get("PiExperiment").execute("6", { Focus: "xvfb timeout", Intelligent: false }, undefined, undefined, ctx);
	assert.ok(experiment.structuredContent.Steps.length > 0);
	const event: any = { messageType: "user", prompt: "xvfb timeout", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.equal(event.systemPromptOptions.sections["pi-mnemonic-meta"], "");
});

test("PiStats reports instrumented tool usage when enabled", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiMnemonicSet").execute("1", { Key: "observability.enabled", Value: "true" }, undefined, undefined, ctx);
	await tools.get("PiMnemonicStats").execute("2", {}, undefined, undefined, ctx);
	await tools.get("PiMnemonicStats").execute("3", {}, undefined, undefined, ctx);
	const report = await tools.get("PiStats").execute("4", { Action: "Dump" }, undefined, undefined, ctx);
	assert.ok(JSON.parse(report.content[0].text).Usage.Total >= 2);
});

test("technique execution timeout and reserved keys are enforced", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const set = await tools.get("PiMnemonicSet").execute("1", { Key: "charter.mode", Value: "off" }, undefined, undefined, ctx);
	assert.equal(set.isError, true);
	const technique = tools.get("PiTechnique");
	await technique.execute("2", { Action: "Add", Name: "slow", Command: "sleep 2" }, undefined, undefined, ctx);
	const result = await technique.execute("3", { Action: "Exec", Name: "slow", TimeoutMs: 500 }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /timedOut=true|code=null/);
});

test("technique Expose generates a PiTechnique tool", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const technique = tools.get("PiTechnique");
	await technique.execute("1", { Action: "Add", Name: "scan-repo", Command: "rg -n {{Pattern}} {{Path}}", Params: ["Pattern", "Path"] }, undefined, undefined, ctx);
	await technique.execute("2", { Action: "Expose", Name: "scan-repo" }, undefined, undefined, ctx);
	assert.ok(tools.has("PiTechniqueScanRepo"));
	await technique.execute("3", { Action: "Add", Name: "echo-safe", Command: "printf '%s' {{Value}}" }, undefined, undefined, ctx);
	const executed = await technique.execute("4", { Action: "Exec", Name: "echo-safe", Vars: JSON.stringify({ Value: "a; echo INJECTED" }) }, undefined, undefined, ctx);
	assert.match(executed.content[0].text, /a; echo INJECTED/);
	assert.doesNotMatch(executed.content[0].text, /^INJECTED/m);
	const list = await tools.get("PiMnemonicList").execute("5", {}, undefined, undefined, ctx);
	assert.ok(Array.isArray(list.details) || typeof list.content[0].text === "string");
});
