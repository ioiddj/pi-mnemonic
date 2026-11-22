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
	const bus = new Map<string, any>();
	const pi: any = {
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		appendEntry: () => {},
		sendMessage: () => {},
		events: {
			emit: (channel: string, data: any) => bus.get(channel)?.(data),
			on: (channel: string, handler: any) => {
				bus.set(channel, handler);
				return () => bus.delete(channel);
			},
		},
	};
	return { pi, tools, commands, handlers, bus };
}

test("mines pi-fleet run events into fleet-tagged knowledge", async () => {
	const { pi, tools, handlers, bus } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const fleet = bus.get("pi-fleet:run");
	assert.ok(fleet, "missing pi-fleet:run subscriber");
	await fleet({
		traceId: "trace-123",
		depth: 1,
		children: [
			{ id: "root.1", role: "scout", status: "completed", task: "inspect cache", output: "Root cause: stale cache invalidated the result\nCODIFY: Bound every listener with an explicit dispose path." },
			{ id: "root.2", role: "worker", status: "failed", task: "patch", output: "", error: "Fix: apply the patch atomically" },
		],
	});
	const recalled = await tools.get("PiMnemonicRecall").execute("1", { Query: "stale cache invalidated the result", Tags: ["fleet-mined"], Limit: 5 }, undefined, undefined, ctx);
	assert.ok(recalled.details.hits.some((hit: any) => JSON.stringify(hit).includes("stale cache")));
	const stats = await tools.get("PiMnemonicStats").execute("2", {}, undefined, undefined, ctx);
	assert.ok(Number(JSON.parse(stats.content[0].text).episodes) >= 1);

	await tools.get("PiMnemonicSet").execute("3", { Key: "fleet.mine", Value: false }, undefined, undefined, ctx);
	await fleet({ traceId: "trace-456", depth: 0, children: [{ id: "root.3", status: "completed", output: "Finding: disabled fleet mining should not store this claim" }] });
	const disabled = await tools.get("PiMnemonicRecall").execute("4", { Query: "disabled fleet mining should not store this claim", Limit: 5 }, undefined, undefined, ctx);
	assert.equal(disabled.details.hits.some((hit: any) => JSON.stringify(hit).includes("disabled fleet mining")), false);
});

test("auto-tags new memory with the project and recalls it by scope", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: "/home/user/projects/pi-fleet", sessionManager: { getBranch: () => [] } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiMnemonicLearn").execute("1", { Claim: "pi-fleet children never run quality gates", Tags: ["concept:fleet"] }, undefined, undefined, ctx);
	await tools.get("PiMnemonicLearn").execute("2", { Claim: "Xvfb tests need GLX disabled", Tags: ["concept:xvfb"] }, undefined, undefined, ctx);
	const scoped = await tools.get("PiMnemonicRecall").execute("3", { Query: "children quality gates", Project: "pi-fleet" }, undefined, undefined, ctx);
	assert.ok(scoped.details.tags.includes("project:pi-fleet"));
	assert.ok(scoped.details.hits.some((hit: any) => hit.Tags.includes("project:pi-fleet") || hit.Tags.includes("pi-fleet")));
	const concept = await tools.get("PiMnemonicRecall").execute("4", { Query: "GLX disabled", Tags: ["concept:xvfb"] }, undefined, undefined, ctx);
	assert.ok(concept.details.hits.some((hit: any) => /Xvfb/.test(hit.Text)));
	const event: any = { messageType: "user", prompt: "children quality gates", systemPromptOptions: { sections: {}, cwd: ctx.cwd, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.match(event.systemPromptOptions.sections["pi-mnemonic-recall"], /Scope: project:pi-fleet/);
});

test("idle miner still extracts facts from session transcripts", async () => {
	const sessionDir = path.join(temp, "sessions", "miner-test");
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionDir, "session.jsonl"),
		`${JSON.stringify({ message: { role: "assistant", content: "Root cause: session miner refactor keeps transcript facts" } })}\n`,
	);
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, isIdle: () => true, hasPendingMessages: () => false };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiDream").execute("1", { Action: "Run", Intelligent: false }, undefined, undefined, ctx);
	const recalled = await tools.get("PiMnemonicRecall").execute("2", { Query: "session miner refactor keeps transcript facts", Tags: ["session-mined"], Limit: 5 }, undefined, undefined, ctx);
	assert.ok(recalled.details.hits.some((hit: any) => JSON.stringify(hit).includes("session miner refactor keeps transcript facts")));
});

test("registers PascalCase tools and lowercase kebab commands", () => {
	const { pi, tools, commands, handlers } = MockPi();
	PiMnemonic(pi);
	for (const name of [
		"PiMnemonicHelp", "PiMnemonicSet", "PiMnemonicGet", "PiMnemonicList", "PiMnemonicDelete",
		"PiMnemonicLearn", "PiMnemonicNote", "PiMnemonicRender", "PiTechnique", "PiMnemonicWarm", "PiMnemonicRecall", "PiMnemonicCodify", "PiMnemonicLink",
		"PiAssociate", "PiDream", "PiPlan", "PiImagine", "PiSimulate", "PiReflect", "PiObserve",
		"PiPredict", "PiRiskAssessment", "PiAssessment", "PiQuantify", "PiModel", "PiHypothesis", "PiExperiment", "PiPrune", "PiCharter", "PiPrompt", "PiStats", "PiMemoryCompat", "PiMnemonicStats",
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

test("bracketed reserved keys and malformed markdown cannot bypass guards", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => false } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const reserved = await tools.get("PiMnemonicSet").execute("1", { Key: 'dream["autoPromote"]', Value: "true" }, undefined, undefined, ctx);
	assert.equal(reserved.isError, true);
	const promote = await tools.get("PiDream").execute("2", { Action: "Promote" }, undefined, undefined, ctx);
	assert.equal(promote.isError, true);
	const event: any = { messageType: "user", prompt: "x", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [{ path: path.join(temp, "AGENTS.md"), content: "{{#if x}}broken" }] } };
	await assert.doesNotReject(handlers.get("before_agent_start")(event, ctx));
	assert.equal(event.systemPromptOptions.contextFiles[0].content, "{{#if x}}broken");
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

test("idle miner config is opt-in and operator-gated", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	let confirm = false;
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, confirm: async () => confirm } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const denied = await tools.get("PiDream").execute("1", { Action: "Config", Enabled: true }, undefined, undefined, ctx);
	assert.equal(denied.isError, true);
	confirm = true;
	const configured = await tools.get("PiDream").execute("2", { Action: "Config", Enabled: true, IdleMs: 30000, Depth: 4, SweepKb: 64 }, undefined, undefined, ctx);
	const value = JSON.parse(configured.content[0].text);
	assert.equal(value.Enabled, true);
	assert.equal(value.IdleMs, 30000);
	assert.equal(value.Depth, 4);
	assert.equal(value.SweepKb, 64);
});

test("engram compatibility mode suppresses overlapping context", async () => {
	const { pi, tools, handlers } = MockPi();
	pi.getCommands = () => [{ name: "engram-registers" }];
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	const status = await tools.get("PiMemoryCompat").execute("1", { Action: "Status" }, undefined, undefined, ctx);
	assert.equal(JSON.parse(status.content[0].text).Detected, true);
	await tools.get("PiMemoryCompat").execute("2", { Action: "Set", Mode: "engram-primary" }, undefined, undefined, ctx);
	const event: any = { messageType: "user", prompt: "hello", systemPromptOptions: { sections: {}, cwd: temp, contextFiles: [] } };
	await handlers.get("before_agent_start")(event, ctx);
	assert.equal(event.systemPromptOptions.sections["pi-mnemonic"], "");
});

test("PiStats reports instrumented tool usage when enabled", async () => {
	const { pi, tools, handlers } = MockPi();
	PiMnemonic(pi);
	const ctx: any = { cwd: temp, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }), ui: { notify: () => {}, confirm: async () => true } };
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await tools.get("PiStats").execute("1", { Action: "Enable" }, undefined, undefined, ctx);
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
