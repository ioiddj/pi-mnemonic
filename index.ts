import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { AssociateSectionName, BuildAssociateContext, BuildAssociations, BuildContext, BuildLinkHints, ContextSectionName, LinkSectionName, RecallSectionName } from "./src/context.ts";
import { GenerateCounterfactuals } from "./src/imagine.ts";
import { PromptStructured } from "./src/intelligence.ts";
import { PromptKeys, PromptSource, PromptText, ResetPromptCard, WritePromptCard } from "./src/prompt-cards.ts";
import { DEFAULT_PROMPTS } from "./src/prompt-defaults.ts";
import { DEFAULT_CHARTER_PATTERNS, DEFAULT_PRUNE_PATTERNS, DEFAULT_TRIGGER_PATTERNS } from "./src/tripwire.ts";
import { AssessRisk, DesignExperiment, Hypothesize, Predict, Quantify, type Evidence } from "./src/meta.ts";
import { DEFAULT_REFLECT_PATTERNS, DeterministicReflection, EvaluateTriggers, ReflectionToInnerText, ReflectionToText, type ReflectResult } from "./src/reflect.ts";
import { WarmMarkdownLinks, WeaveRelatedLinks } from "./src/links.ts";
import { CAPS, MnemonicStore, type Technique } from "./src/store.ts";
import { redactCommand } from "./src/redact.ts";
import { RenderMarkdown, RenderTemplate } from "./src/template.ts";

type AnyRecord = Record<string, unknown>;

const CHARTER_SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), ".config", "charter", "SOURCES.md");

async function OperatorConfirm(ctx: any, label: string): Promise<boolean> {
	if (process.env.PI_MNEMONIC_ALLOW_OPERATOR_WRITES === "1") return true;
	if (typeof ctx?.ui?.confirm !== "function") return false;
	try {
		return Boolean(await ctx.ui.confirm(label, "This changes operator-controlled configuration."));
	} catch {
		return false;
	}
}

class MnemonicError extends Error {
	hint: string;

	constructor(message: string, hint: string) {
		super(message);
		this.hint = hint;
	}
}

function Result(text: string, details: AnyRecord = {}, structuredContent?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(structuredContent === undefined ? {} : { structuredContent }),
	};
}

function ErrorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const hint = error instanceof MnemonicError ? error.hint : "Call PiMnemonicHelp for tool arguments and examples.";
	return Result(`Error: ${message}\nHint: ${hint}`, { error: true });
}

function Execute(handler: (params: any, signal?: AbortSignal, ctx?: any) => Promise<any> | any) {
	return async (_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) => {
		try {
			return await handler(params, signal, ctx);
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
			return { ...ErrorResult(error), isError: true };
		}
	};
}

function ParseValue(raw: string | undefined, field: string): unknown {
	if (raw === undefined) return undefined;
	const text = String(raw).trim();
	if (!text) return "";
	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			return JSON.parse(text);
		} catch {
			throw new MnemonicError(`${field} looks like JSON but did not parse.`, `Pass valid JSON, or prefix plain text with a word (for example: "hostport=8787").`);
		}
	}
	if (text === "true") return true;
	if (text === "false") return false;
	return raw;
}

function ParseVars(raw: string | undefined): AnyRecord {
	const value = ParseValue(raw, "Vars");
	if (value === undefined || value === "") return {};
	if (value && typeof value === "object" && !Array.isArray(value)) return value as AnyRecord;
	throw new MnemonicError("Vars must be a JSON object.", "Example Vars: {\"Port\":\"8787\"}");
}

function ToPascal(name: string): string {
	const pascal = name
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
	return /^[A-Za-z]/.test(pascal) ? pascal : `Technique${pascal}`;
}

function ResolveSkillsDir(): string {
	return process.env.PI_MNEMONIC_SKILLS_DIR
		? path.resolve(process.env.PI_MNEMONIC_SKILLS_DIR)
		: path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "skills");
}

function SkillName(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (!slug) throw new MnemonicError("Skill Name must contain letters or numbers.", "Example: { Kind:'Skill', Name:'xvfb-safe-tests', Summary:'...' }");
	return slug;
}

function WriteSkillFile(name: string, summary: string, detail: string, command: string | undefined, tags: string[]): string {
	const slug = SkillName(name);
	const dir = path.join(ResolveSkillsDir(), slug);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const skillFile = path.join(dir, "SKILL.md");
	const triggerLine = tags.length ? ` Use when working with: ${tags.join(", ")}.` : "";
	const codeBlock = command ? `\n\n\`\`\`sh\n${command}\n\`\`\`\n` : "";
	const body = [
		"---",
		`name: ${slug}`,
		`description: ${summary.slice(0, 1024).replace(/\s+/g, " ")}${triggerLine.slice(0, 400)}`,
		"---",
		"",
		`# ${summary}`,
		"",
		detail || "Follow this technique when the trigger description matches the task.",
		codeBlock,
	].join("\n");
	if (fs.existsSync(skillFile)) {
		const existing = fs.readFileSync(skillFile, "utf8");
		if (existing.length > 100_000) throw new MnemonicError(`Skill ${slug} is too large to append.`, "Edit the SKILL.md manually or choose a new Name.");
		fs.appendFileSync(skillFile, `\n\n## Update ${new Date().toISOString()}\n\n${summary}\n\n${detail}\n`, { mode: 0o600 });
	} else {
		fs.writeFileSync(skillFile, body, { mode: 0o600 });
	}
	return skillFile;
}

function AgentRulesPath(): string {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "AGENTS.md");
}

function AppendAgentRule(key: string, summary: string): string {
	const file = AgentRulesPath();
	const clean = summary.replace(/[\r\n]+/g, " ").replace(/[{}]/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
	const line = `- {{${key}}} — ${clean}`;
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Universal agent rules\n";
	if (existing.includes(line)) return file;
	if (existing.length + line.length + 4 > 100_000) throw new MnemonicError("Global AGENTS.md is too large to append.", "Edit it manually or choose a narrower rule.");
	fs.writeFileSync(file, `${existing.trimEnd()}\n${line}\n`, { mode: 0o600 });
	return file;
}

function MessageText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const assistant = [...messages].reverse().find((message: any) => message?.role === "assistant" || message?.message?.role === "assistant");
	const content = assistant?.content ?? assistant?.message?.content;
	if (typeof content === "string") return content.slice(0, 1200);
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text || ""))
		.join("\n")
		.slice(0, 1200);
}

function ShouldPromote(text: string): boolean {
	return /(?:must|always|never|root cause|verified|on this host|do not|avoid)/i.test(text) && !/(?:maybe|perhaps|guess|unverified)/i.test(text);
}

function PromoteFacts(store: MnemonicStore, max = 2): string[] {
	const candidates = store.Recall("must always never root cause verified on this host do not avoid", 20);
	const promoted: string[] = [];
	for (const hit of candidates) {
		if (promoted.length >= max) break;
		if (!ShouldPromote(hit.Text)) continue;
		const hash = createHash("sha1").update(hit.Text).digest("hex").slice(0, 8);
		const key = `rule.promoted_${hash}`;
		try {
			AppendAgentRule(key, hit.Text);
			promoted.push(key);
		} catch {
			// Promote only what fits; a full AGENTS.md is not a failure of the pass.
		}
	}
	return promoted;
}

function HelpText(): string {
	return [
		"PiMnemonic API",
		"",
		"PiMnemonicSet { Key, Value, Tags? } — store a register. Key supports dot/bracket paths: hosts.dev[0]. Value is JSON when it starts with { or [, otherwise plain text.",
		"PiMnemonicGet { Key, Template?, Vars? } — read a register and bump its hit count. Template uses Handlebars syntax; exact values are interpolated, not copied into prompts.",
		"PiMnemonicList { Prefix?, IncludeValues? } — list register names/metadata without values by default.",
		"PiMnemonicDelete { Key } — remove a register or nested path.",
		"PiMnemonicLearn { Claim, Tags?, Confidence?, Source? } — store a deduplicated generalizable fact.",
		"PiMnemonicNote { Summary, Detail?, Tags? } — record recent work so the next run starts warm.",
		"PiMnemonicRender { Template, Vars? } — render Handlebars with registers + Vars. Helpers: count, at; built-ins: #each, lookup, if.",
		"PiTechnique { Action, Name?, Command?, Description?, Usage?, Params?, Cwd?, Tags?, Vars?, TimeoutMs? } — Actions: Add, Get, List, Render, Delete, Hit, Script, Expose, Exec.",
		"PiMnemonicWarm { Keys? } — bump hit counts and return the current warm context.",
		"PiMnemonicRecall { Query, Limit? } — associative recall of registers, facts, episodes, and techniques by token overlap plus recency/hits.",
		"PiMnemonicCodify { Kind, Name, Summary, Detail?, Command?, Tags?, Params?, Expose? } — Kind: Register, Technique, Tool, Skill, AgentRule. AgentRule appends a {{register}} token to global AGENTS.md; AGENTS.md markdown values are interpolated before each run.",
		"PiMnemonicLink { Action, Path, Depth?, MaxLinks? } — Action Warm caches markdown link hints; Weave adds a Related section linking neighboring docs.",
		"PiAssociate { Action? } — passive session association (on/off/status). Compares prompts and responses with prior work to surface what worked, failed, and what lesson transfers.",
		"PiDream { Action?, MaxSessions?, Promote? } — idle knowledge miner. Run/Status/Promote/Config; promotes high-confidence rules to AGENTS.md.",
		"PiImagine { Focus?, Limit? } — speculative counterfactuals: how a session could have gone differently and what is worth remembering.",
		"PiSimulate { Focus?, Limit? } — rigorous counterfactuals with Hypothesis, Experiment, and Success criteria.",
		"PiReflect / PiObserve { Action, Focus?, Intelligent? } — conditional metacognition. Actions Run/Status/Config/Enable/Disable; returns Verdict, Guidance, NextAction, InjectedPrompt, risks and stop conditions, then injects that exact prompt into the next turn.",
		"PiPredict — evidence-grounded forecast. PiRiskAssessment / PiAssessment — quantitative risk register. PiQuantify / PiModel — bounded variable model. PiHypothesis — falsifiable hypothesis. PiExperiment — bounded experiment design, optionally run via a PiTechnique.",
		"PiPrompt { Action: List|Get|Set|Reset, Key?, Prompt? } — edit YAML prompt cards in .config/prompts; defaults remain in src/prompt-defaults.ts.",
		"PiPrune { Action: Preview|Run|Restore|Status|Config, Key?, Focus?, Reason?, Intelligent? } — move unused/noisy memory into cold storage; supports manual, agent, regex/keyword/code, and typed decision triggers.",
		"PiStats { Action: Dump|Enable|Disable|Export|Query|Reset, Format?, Path?, Limit?, SinceMs? } — opt-in usage telemetry and exports to JSON/JSONL/eval/LangSmith/Langfuse/OTel.",
		"PiCharter { Action: Show|Config|Enable|Disable|Source, Mode?, EveryNTurns? } — operating charter with source links; default trigger mode fires only for sanctioned-party or sanctions/export-control work (modes always/trigger/periodic/off).",
		"Pin syntax in markdown: {{key!important}}, {{key#alwayson}}, {{key//remember}} pin a register/fact/episode/technique so pruning skips it. Source index: .config/charter/SOURCES.md.",
		"Repeated PiAssociate signals can promote cold items back into active memory when associate.promoteThreshold hits (default 5).",
		"Set meta.auto=true via PiMnemonicSet to enable deterministic quantitative tripwire context when usage >=80% or a tool repeats >=5 times.",
		"PiMnemonicStats {} — show store counts and caps.",
		"PiMnemonicHelp { Topic? } — this document.",
		"",
		"Commands: /pi-mnemonic-help, /pi-mnemonic-status, /pi-mnemonic-warm [Key,Key].",
		"When you notice a reusable trajectory, capability, or new knowledge, call PiMnemonicCodify instead of letting it disappear into the transcript. Prefer Technique/Tool for commands, Skill for multi-step knowledge, and AgentRule for globally important rules.",
		"AGENTS.md and other markdown context files are interpolated with {{register}} tokens before each run ({{secret:...}} tokens are preserved). Markdown links are warmed into cached hints; PiMnemonicLink Weave links documents to their neighbors. PiDream mines past sessions when memory headroom is available; PiAssociate injects passive session associations; PiImagine/PiSimulate turn outcomes into counterfactual lessons; PiReflect triggers step-back guidance on phrases, turn counts, context pressure, repeated tools, or manual request.",
		`Caps: ${CAPS.registers} registers, ${CAPS.registerBytes} register bytes, ${CAPS.valueBytes} per value, ${CAPS.facts} facts, ${CAPS.episodes} episodes, ${CAPS.techniques} techniques, ${CAPS.dynamicTools} generated tools.`,
		"Techniques with Expose become PiTechnique<Name> tools with one string parameter per declared Param.",
		"Security: never store secrets in registers. Use credential_set / {{secret:NAME}} for credentials.",
	].join("\n");
}

async function RunCommand(command: string, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<AnyRecord> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	const limit = 20_480;
	let used = 0;
	let stdout = "";
	let stderr = "";
	let truncated = false;
	const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
		const remaining = limit - used;
		if (remaining <= 0) {
			truncated = true;
			return;
		}
		const text = chunk.toString("utf8");
		const kept = text.slice(0, remaining);
		used += kept.length;
		truncated ||= text.length > kept.length;
		if (stream === "stdout") stdout += kept;
		else stderr += kept;
	};

	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", command], {
			cwd: cwd || process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		};
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};
		const killGroup = (reason: "timeout" | "abort") => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch { /* already gone */ }
			}
			child.stdout.destroy();
			child.stderr.destroy();
			finish(() => reason === "abort"
				? reject(new DOMException("Aborted", "AbortError"))
				: resolve({ code: null, stdout, stderr, truncated: true, command, timedOut: true }));
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		timer = setTimeout(() => killGroup("timeout"), timeoutMs);
		onAbort = () => killGroup("abort");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => finish(() => reject(error)));
		child.once("close", (code) => finish(() => {
			if (signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
			else resolve({ code, stdout, stderr, truncated, command });
		}));
	});
}

function SanitizeOutput(output: AnyRecord): AnyRecord {
	return {
		...output,
		command: redactCommand(String(output.command ?? "")),
		stdout: redactCommand(String(output.stdout ?? "")),
		stderr: redactCommand(String(output.stderr ?? "")),
	};
}

const ScenarioStructuredSchema = Type.Object({
	Scenarios: Type.Array(Type.Object({
		Source: Type.String(),
		Trigger: Type.String(),
		Counterfactual: Type.String(),
		Lesson: Type.String(),
		Hypothesis: Type.Optional(Type.String()),
		Experiment: Type.Optional(Type.String()),
		Success: Type.Optional(Type.String()),
	})),
});

const AssociateStructuredSchema = Type.Object({
	Relevance: Type.Number(),
	WhatWorked: Type.String(),
	WhatFailed: Type.String(),
	Trajectory: Type.String(),
	Outcome: Type.String(),
	Lesson: Type.String(),
	ShouldUse: Type.Boolean(),
});

const DreamStructuredSchema = Type.Object({
	Facts: Type.Array(Type.String()),
	Skills: Type.Array(Type.Object({ Name: Type.String(), Summary: Type.String() })),
	Promote: Type.Array(Type.String()),
});

const PredictionStructuredSchema = Type.Object({
	Focus: Type.String(), Forecast: Type.String(), Confidence: Type.Number(), BaseRate: Type.Number(), EvidenceCount: Type.Number(),
	Drivers: Type.Array(Type.String()), CounterEvidence: Type.Array(Type.String()), ExpectedOutcome: Type.String(), StopConditions: Type.Array(Type.String()),
});

const RiskStructuredSchema = Type.Object({
	Focus: Type.String(), RiskScore: Type.Number(), Likelihood: Type.Number(), Impact: Type.Number(),
	Risks: Type.Array(Type.Object({ Risk: Type.String(), Severity: Type.Number(), Likelihood: Type.Number(), Mitigation: Type.String() })),
	Recommendation: Type.String(), StopConditions: Type.Array(Type.String()),
});

const QuantStructuredSchema = Type.Object({
	Focus: Type.String(),
	Variables: Type.Array(Type.Object({ Name: Type.String(), Value: Type.Union([Type.Number(), Type.String()]), Unit: Type.String(), Source: Type.String() })),
	Formula: Type.String(), Estimate: Type.String(), Uncertainty: Type.Number(), DataGaps: Type.Array(Type.String()), NextMeasurement: Type.String(),
});

const HypothesisStructuredSchema = Type.Object({
	Claim: Type.String(), Null: Type.String(), Variables: Type.Array(Type.String()), Metric: Type.String(),
	SuccessCriterion: Type.String(), Falsifier: Type.String(), Evidence: Type.Array(Type.String()), Cost: StringEnum(["low", "medium", "high"] as const),
});

const ExperimentStructuredSchema = Type.Object({
	Hypothesis: Type.String(), Steps: Type.Array(Type.String()), Control: Type.String(), Budget: Type.String(),
	ExpectedResult: Type.String(), Disconfirmation: Type.String(), StopConditions: Type.Array(Type.String()),
	TechniqueName: Type.Optional(Type.String()), Observation: Type.Optional(Type.String()),
});

const ReflectStructuredSchema = Type.Object({
	Verdict: StringEnum(["Continue", "Scope", "Reset", "Plan", "Exit"] as const),
	Useful: Type.Boolean(),
	Rational: Type.Boolean(),
	Aligned: Type.Boolean(),
	Novelty: StringEnum(["low", "medium", "high"] as const),
	Risks: Type.Array(Type.String()),
	Guidance: Type.String(),
	NextAction: Type.String(),
	InjectedPrompt: Type.String(),
	StopConditions: Type.Array(Type.String()),
	Evidence: Type.Array(Type.String()),
	Confidence: Type.Number(),
});

const PlanStructuredSchema = Type.Object({
	RevisedGoal: Type.String(),
	Steps: Type.Array(Type.String()),
	Risks: Type.Array(Type.String()),
	NextActions: Type.Array(Type.String()),
});

const BACKGROUND_MIN_AVAILABLE_BYTES = 2 * 1024 ** 3;
const BACKGROUND_MAX_SESSIONS = 10;
const BACKGROUND_SESSION_BYTES = 512 * 1024;
const BACKGROUND_MAX_FACTS = 20;

function HasHeadroom(): boolean {
	try {
		const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
		const available = Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1] || 0) * 1024;
		if (available < BACKGROUND_MIN_AVAILABLE_BYTES) return false;
		if (fs.existsSync("/sys/fs/cgroup/memory.max")) {
			const max = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
			if (max !== "max") {
				const current = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
				if (current / Number(max) > 0.85) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function SessionFiles(limit: number): string[] {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const root = path.join(base, "sessions");
	if (!fs.existsSync(root)) return [];
	const files: Array<{ file: string; mtime: number }> = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dir, name);
			try {
				files.push({ file, mtime: fs.statSync(file).mtimeMs });
			} catch {
				// A session may disappear mid-scan.
			}
		}
	}
	return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.file);
}

function ExtractSessionKnowledge(file: string): { facts: string[]; episode?: string; skills: Array<{ name: string; summary: string }> } {
	const fd = fs.openSync(file, "r");
	const size = Math.min(BACKGROUND_SESSION_BYTES, fs.statSync(file).size);
	const buffer = Buffer.alloc(size);
	const read = fs.readSync(fd, buffer, 0, size, 0);
	fs.closeSync(fd);
	const facts: string[] = [];
	const skills: Array<{ name: string; summary: string }> = [];
	let episode: string | undefined;
	const pattern = /^\s*(?:[-*]\s*)?(?:root cause|cause|fix|verified|verdict|conclusion|learned|finding|result|decision|note|shortcut|hint)\b[:\-]?\s*(.+)$/i;
	for (const line of buffer.slice(0, read).toString("utf8").split(/\r?\n/)) {
		let text = line;
		try {
			const entry = JSON.parse(line) as AnyRecord;
			const message = entry.message as AnyRecord | undefined;
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const content = message.content;
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) text = content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join(" ");
			else continue;
		} catch {
			continue;
		}
		if (!episode && text.trim()) episode = text.trim().split(/\n/)[0].slice(0, 180);
		const skill = /^\s*SKILL:\s*([a-z0-9_-]+)\s*\|\s*(.+)$/.exec(text);
		if (skill && skills.length < 4) skills.push({ name: skill[1], summary: skill[2].trim().slice(0, 240) });
		const codify = /^\s*CODIFY:\s*(.+)$/.exec(text);
		if (codify && facts.length < BACKGROUND_MAX_FACTS) {
			const claim = `Codify: ${codify[1].replace(/\s+/g, " ").trim().slice(0, 240)}`;
			if (!facts.includes(claim)) facts.push(claim);
		}
		const match = pattern.exec(text);
		if (match && facts.length < BACKGROUND_MAX_FACTS) {
			const claim = match[1].replace(/\s+/g, " ").trim().slice(0, 240);
			if (claim.length > 20 && !facts.includes(claim)) facts.push(claim);
		}
	}
	return { facts, episode, skills };
}

export default function PiMnemonic(pi: ExtensionAPI) {
	let store: MnemonicStore | undefined;
	let dreamingActive = false;
	let shuttingDown = false;
	let transientPrompt = "";
	let transientResponse = "";
	let transientAt = 0;
	const generatedTools = new Map<string, string>();

	const GetStore = (): MnemonicStore => {
		if (!store) store = new MnemonicStore();
		return store;
	};
	const Flush = () => {
		try {
			store?.flush();
		} catch (error) {
			pi.events.emit("pi-mnemonic:flush-error", { message: String(error) });
		}
	};
	const ObserveEnabled = () => GetStore().peek("observability.enabled") === true;
	const ByteCount = (value: unknown): number => {
		try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); } catch { return 0; }
	};
	const RecordToolUsage = (tool: string, params: AnyRecord, started: number, result: unknown, error?: unknown, modelId?: string) => {
		if (!ObserveEnabled()) return;
		const store = GetStore();
		const action = String(params?.Action || params?.Kind || params?.Topic || "");
		store.RecordUsage({
			Tool: tool,
			Action: action,
			DurationMs: Date.now() - started,
			Success: !error && !(result as AnyRecord)?.isError,
			ErrorCode: error instanceof Error ? error.name : undefined,
			InputBytes: ByteCount(params),
			OutputBytes: ByteCount(result),
			Model: String(modelId || ""),
			Meta: { source: "tool" },
		});
		Flush();
	};
	const RegisterTool = (definition: AnyRecord) => {
		pi.registerTool({
			...(definition as any),
			execute: async (toolCallId: string, params: AnyRecord, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any) => {
				const started = Date.now();
				try {
					const result = await (definition as any).execute(toolCallId, params, signal, onUpdate, ctx);
					RecordToolUsage(String(definition.name), params, started, result, undefined, String(ctx?.model?.id || ""));
					return result;
				} catch (error) {
					RecordToolUsage(String(definition.name), params, started, undefined, error, String(ctx?.model?.id || ""));
					throw error;
				}
			},
		});
	};


	const StoreVariables = (): AnyRecord => {
		const context: AnyRecord = {};
		for (const row of GetStore().list("", true)) {
			const key = row.key as string | undefined;
			if (!key) continue;
			context[key] = row.value;
			const parts = key.split(".").filter(Boolean);
			if (parts.length < 2) continue;
			let node: AnyRecord = context;
			for (let i = 0; i < parts.length - 1; i++) {
				const part = parts[i];
				if (!node[part] || typeof node[part] !== "object") node[part] = {};
				node = node[part] as AnyRecord;
			}
			node[parts[parts.length - 1]] = row.value;
		}
		return context;
	};
	const ApplyPinTokens = (text: string, scope: string): string => text.replace(/\{\{([A-Za-z_][\w.-]*)(?:[!#]|\/\/)([\w-]+)\}\}/g, (_whole, key: string, _flag: string) => {
		return GetStore().Pin(key, scope) ? `{{${key}}}` : "";
	});
	const RenderWith = (template: string, vars: AnyRecord = {}): string => RenderTemplate(template, { ...StoreVariables(), ...vars });
	const ShellQuote = (value: unknown): string => {
		const text = value === undefined || value === null ? "" : String(value);
		if (/[\0\r\n]/.test(text)) throw new MnemonicError("Technique parameters cannot contain newlines or NUL bytes.", "Pass a single-line value or use a file path/register key.");
		return `'${text.replace(/'/g, `'\\''`)}'`;
	};
	const RenderTechnique = (template: string, vars: AnyRecord = {}): string => {
		const quoted = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, ShellQuote(value)]));
		return RenderTemplate(template, { ...quoted });
	};
	const RegisterTechniqueTools = () => {
		const current = GetStore();
		for (const technique of current.allTechniques().filter((r) => r.expose).slice(0, CAPS.dynamicTools)) {
			const existing = generatedTools.get(technique.id);
			if (existing) continue;
			let toolName = `PiTechnique${ToPascal(technique.name)}`;
			const taken = (name: string) => [...generatedTools.values()].includes(name) || (pi.getAllTools?.() || []).some((tool: AnyRecord) => tool.name === name);
			if (taken(toolName)) toolName = `${toolName}${createHash("sha1").update(technique.id).digest("hex").slice(0, 6).toUpperCase()}`;
			if (taken(toolName)) continue;
			const props: Record<string, ReturnType<typeof Type.String>> = {};
			for (const param of technique.params) props[param] = Type.String({ description: `Value for ${param}` });
			generatedTools.set(technique.id, toolName);
			RegisterTool({
				name: toolName,
				label: toolName,
				description: `${technique.description} Usage: ${technique.usage}`,
				promptSnippet: `Run the stored ${technique.name} technique through a deterministic, capped shell command`,
				parameters: Type.Object(props),
				execute: Execute(async (params: AnyRecord, signal?: AbortSignal) => {
					const live = GetStore();
					const target = live.techniquePeek(technique.name);
					if (!target) throw new MnemonicError(`Technique ${technique.name} was deleted.`, "Call PiTechnique List to see available techniques.");
					live.techniqueGet(technique.name);
					const rendered = RenderTechnique(target.command, params || {});
					const output = await RunCommand(rendered, target.cwd, 30_000, signal);
					Flush();
					return Result(`Technique ${target.name} exit=${output.code}${output.timedOut ? " timedOut=true" : ""}\n${redactCommand(String(output.stdout ?? ""))}${output.stderr ? `\n[stderr]\n${redactCommand(String(output.stderr ?? ""))}` : ""}${output.truncated ? "\n[output truncated]" : ""}`, SanitizeOutput(output));
				}),
			});
		}
	};

	const DreamRun = async (ctx: any, promote = false, force = false, aborted = false) => {
		if (shuttingDown || aborted || ctx?.signal?.aborted) return { processed: 0, promoted: [] as string[], skipped: true };
		if (dreamingActive) return { processed: 0, promoted: [] as string[], skipped: true };
		if (!HasHeadroom() || (!force && (ctx?.isIdle?.() === false || ctx?.hasPendingMessages?.()))) return { processed: 0, promoted: [] as string[], skipped: true };
		dreamingActive = true;
		try {
		const current = GetStore();
		const indexedRaw = current.peek("background.indexed");
		const indexed = Array.isArray(indexedRaw) ? (indexedRaw as string[]).filter((x) => typeof x === "string") : [];
		const set = new Set(indexed);
		let processed = 0;
		const configuredMax = Number(current.peek("dream.maxSessions"));
		const sessionLimit = Number.isFinite(configuredMax) && configuredMax > 0
			? Math.min(BACKGROUND_MAX_SESSIONS, Math.floor(configuredMax))
			: BACKGROUND_MAX_SESSIONS;
		for (const file of SessionFiles(sessionLimit)) {
			if (shuttingDown || aborted || ctx?.signal?.aborted) break;
			if (file === process.env.PI_SESSION_FILE || set.has(file)) continue;
			if (!HasHeadroom()) break;
			try {
				const knowledge = ExtractSessionKnowledge(file);
				for (const claim of knowledge.facts) current.learn(claim, ["session-mined"], 0.6, file);
				if (knowledge.episode) current.note(knowledge.episode, `Mined from ${path.basename(file)}`, ["session-mined"]);
				for (const skill of knowledge.skills) WriteSkillFile(skill.name, skill.summary, `Mined from ${path.basename(file)}.`, undefined, ["session-mined"]);
				set.add(file);
				processed += 1;
			} catch {
				// One bad transcript must not stop the idle pass.
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
		const promoted = promote ? PromoteFacts(current, 2) : [];
		if (processed || promoted.length || force) {
			if (processed) current.set("background.indexed", [...set].slice(-200), ["background"]);
			current.set("dream.lastRun", { at: Date.now(), processed, promoted }, ["dream"]);
			Flush();
			pi.events.emit("pi-mnemonic:dreamed", { processed, promoted });
		}
		return { processed, promoted, skipped: false };
		} finally {
			dreamingActive = false;
		}
	};

	RegisterTool({
		name: "PiMnemonicHelp",
		label: "Pi Mnemonic Help",
		description: "Return the PiMnemonic tool API, examples, and caps. Use when unsure which memory tool to call.",
		parameters: Type.Object({ Topic: Type.Optional(Type.String()) }),
		execute: Execute((params: AnyRecord) => Result(HelpText(), { topic: params.Topic || "all" })),
	});

	RegisterTool({
		name: "PiMnemonicSet",
		label: "Pi Mnemonic Set",
		description: "Store a keyed register. Key supports dot/bracket paths. Value is JSON if it starts with { or [, otherwise plain text.",
		promptSnippet: "Store exact reusable values in bounded keyed registers",
		parameters: Type.Object({
			Key: Type.String({ description: "Register key, e.g. hosts.dev[0] or project.ports.api" }),
			Value: Type.String({ description: "JSON or plain-text value" }),
			Tags: Type.Optional(Type.Array(Type.String())),
		}),
		execute: Execute((params: AnyRecord) => {
			const key = String(params.Key);
			const reserved = ["charter.", "dream.", "prune.auto", "reflect.", "associate.", "meta.", "background."];
			if (reserved.some((prefix) => key.startsWith(prefix))) throw new MnemonicError(`Key '${key}' is operator-controlled.`, "Use the corresponding operator tool instead.");
			GetStore().set(key, ParseValue(String(params.Value), "Value"), (params.Tags as string[]) || []);
			Flush();
			return Result(`Stored ${key}`, { key });
		}),
	});

	RegisterTool({
		name: "PiMnemonicGet",
		label: "Pi Mnemonic Get",
		description: "Read a register (bumps its hit count). Optional Template renders Handlebars using registers plus Vars.",
		promptSnippet: "Recall an exact value from a keyed register or nested path",
		promptGuidelines: ["Use PiMnemonicGet when an exact stored value is needed instead of guessing or recopying it."],
		parameters: Type.Object({
			Key: Type.String({ description: "Register key or path" }),
			Template: Type.Optional(Type.String({ description: "Handlebars template, e.g. {{hosts.dev.port}}" })),
			Vars: Type.Optional(Type.String({ description: "Optional JSON object overriding register values" })),
		}),
		execute: Execute((params: AnyRecord) => {
			const value = GetStore().get(String(params.Key));
			if (value === undefined) throw new MnemonicError(`No register '${params.Key}'.`, "Call PiMnemonicList to see available keys, or PiMnemonicSet first.");
			const text = params.Template ? RenderWith(String(params.Template), ParseVars(params.Vars as string | undefined)) : typeof value === "string" ? value : JSON.stringify(value);
			Flush();
			return Result(text, { key: params.Key, value });
		}),
	});

	RegisterTool({
		name: "PiMnemonicList",
		label: "Pi Mnemonic List",
		description: "List register names and metadata. Values are hidden unless IncludeValues is true.",
		parameters: Type.Object({
			Prefix: Type.Optional(Type.String()),
			IncludeValues: Type.Optional(Type.Boolean()),
		}),
		execute: Execute((params: AnyRecord) => Result(JSON.stringify(GetStore().list(String(params.Prefix || ""), Boolean(params.IncludeValues)), null, 2))),
	});

	RegisterTool({
		name: "PiMnemonicDelete",
		label: "Pi Mnemonic Delete",
		description: "Delete a register or nested path.",
		parameters: Type.Object({ Key: Type.String() }),
		execute: Execute((params: AnyRecord) => {
			const removed = GetStore().delete(String(params.Key));
			Flush();
			return Result(removed ? `Deleted ${params.Key}` : `No register ${params.Key}`, { removed });
		}),
	});

	RegisterTool({
		name: "PiMnemonicLearn",
		label: "Pi Mnemonic Learn",
		description: "Store a deduplicated generalizable fact learned from work. Facts are injected into future context when hot.",
		promptSnippet: "Record a reusable fact or lesson from experience",
		parameters: Type.Object({
			Claim: Type.String({ description: "One concise, generalizable statement" }),
			Tags: Type.Optional(Type.Array(Type.String())),
			Confidence: Type.Optional(Type.Number()),
			Source: Type.Optional(Type.String()),
		}),
		execute: Execute((params: AnyRecord) => {
			const fact = GetStore().learn(String(params.Claim), (params.Tags as string[]) || [], Number(params.Confidence ?? 0.8), String(params.Source || "agent"));
			Flush();
			return Result(`Learned ${fact.id}: ${fact.claim}`, { id: fact.id });
		}),
	});

	RegisterTool({
		name: "PiMnemonicNote",
		label: "Pi Mnemonic Note",
		description: "Record recent work as an episode so the next run starts warm. Use after finishing meaningful work.",
		promptSnippet: "Capture a short note about work just completed",
		parameters: Type.Object({
			Summary: Type.String({ description: "One-line summary of what happened" }),
			Detail: Type.Optional(Type.String()),
			Tags: Type.Optional(Type.Array(Type.String())),
		}),
		execute: Execute((params: AnyRecord) => {
			const episode = GetStore().note(String(params.Summary), String(params.Detail || ""), (params.Tags as string[]) || []);
			Flush();
			return Result(`Noted ${episode.id}: ${episode.summary}`, { id: episode.id });
		}),
	});

	RegisterTool({
		name: "PiMnemonicRender",
		label: "Pi Mnemonic Render",
		description: "Render a Handlebars template using stored registers plus Vars. Supports #each, lookup, if, count, at.",
		promptSnippet: "Interpolate stored variables into a template without copying values",
		promptGuidelines: ["Use PiMnemonicRender with register values and {{mustache}} tokens instead of pasting exact strings into prompts."],
		parameters: Type.Object({
			Template: Type.String({ description: "Handlebars template" }),
			Vars: Type.Optional(Type.String({ description: "Optional JSON object overriding register values" })),
		}),
		execute: Execute((params: AnyRecord) => Result(RenderWith(String(params.Template), ParseVars(params.Vars as string | undefined)))),
	});

	RegisterTool({
		name: "PiTechnique",
		label: "Pi Mnemonic Technique",
		description: "Manage deterministic command techniques. Actions: Add, Get, List, Render, Delete, Hit, Script, Expose, Exec.",
		promptSnippet: "Codify a repeated expensive command as a named, documented technique",
		parameters: Type.Object({
			Action: StringEnum(["Add", "Get", "List", "Render", "Delete", "Hit", "Script", "Expose", "Exec"] as const),
			Name: Type.Optional(Type.String()),
			Command: Type.Optional(Type.String()),
			Description: Type.Optional(Type.String()),
			Usage: Type.Optional(Type.String()),
			Params: Type.Optional(Type.Array(Type.String())),
			Cwd: Type.Optional(Type.String()),
			Tags: Type.Optional(Type.Array(Type.String())),
			Vars: Type.Optional(Type.String()),
			TimeoutMs: Type.Optional(Type.Number()),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal) => {
			const current = GetStore();
			const action = String(params.Action);
			const name = String(params.Name || "");
			switch (action) {
				case "Add": {
					if (!name || !params.Command) throw new MnemonicError("Add requires Name and Command.", "Example: { Action:'Add', Name:'scan-repo', Command:'rg -n {{Pattern}} {{Path}}', Params:['Pattern','Path'] }");
					const technique = current.techniqueAdd({
						name,
						command: String(params.Command),
						description: String(params.Description || ""),
						usage: String(params.Usage || ""),
						params: (params.Params as string[]) || [],
						cwd: String(params.Cwd || ""),
						tags: (params.Tags as string[]) || [],
					});
					Flush();
					return Result(`Added technique ${technique.name}. Call Expose to create PiTechnique${ToPascal(technique.name)}.`, { technique });
				}
				case "Get": {
					const technique = current.techniquePeek(name) || (name ? current.techniqueGet(name) : undefined);
					if (!technique) throw new MnemonicError(`No technique '${name}'.`, "Call Action:'List' first.");
					return Result(JSON.stringify(technique, null, 2), { technique });
				}
				case "List":
					return Result(JSON.stringify(current.techniqueList(), null, 2));
				case "Delete": {
					const deleted = current.techniquePeek(name);
					const removed = current.techniqueDelete(name);
					if (deleted) generatedTools.delete(deleted.id);
					Flush();
					return Result(removed ? `Deleted ${name}` : `No technique ${name}`, { removed });
				}
				case "Hit": {
					const technique = current.techniqueGet(name);
					if (!technique) throw new MnemonicError(`No technique '${name}'.`, "Call Action:'List' first.");
					Flush();
					return Result(`Hit ${name} (${technique.hits})`);
				}
				case "Expose": {
					const technique = current.techniquePeek(name);
					if (!technique) throw new MnemonicError(`No technique '${name}'.`, "Add the technique first.");
					current.techniqueAdd({ ...technique, name: technique.name, expose: true });
					Flush();
					RegisterTechniqueTools();
					return Result(`Exposed PiTechnique${ToPascal(technique.name)} with params: ${technique.params.join(", ") || "(none)"}`);
				}
				case "Render":
				case "Script":
				case "Exec": {
					const technique = current.techniqueGet(name);
					if (!technique) throw new MnemonicError(`No technique '${name}'.`, "Call Action:'List' first.");
					const rendered = RenderTechnique(technique.command, ParseVars(params.Vars as string | undefined));
					if (action === "Render") {
						Flush();
						return Result(rendered, { command: rendered });
					}
					if (action === "Script") {
						const file = current.techniqueScript(technique.name, rendered);
						Flush();
						return Result(`Wrote ${file}`, { file, command: rendered });
					}
					const timeout = Math.min(30_000, Math.max(1000, Number(params.TimeoutMs || 15_000)));
					const output = await RunCommand(rendered, technique.cwd || String(params.Cwd || ""), timeout, signal);
					Flush();
					return Result(`Technique ${technique.name} exit=${output.code}${output.timedOut ? " timedOut=true" : ""}\n${redactCommand(String(output.stdout ?? ""))}${output.stderr ? `\n[stderr]\n${redactCommand(String(output.stderr ?? ""))}` : ""}${output.truncated ? "\n[output truncated]" : ""}`, SanitizeOutput(output));
				}
				default:
					throw new MnemonicError(`Unknown Action '${action}'.`, "Use Add, Get, List, Render, Delete, Hit, Script, Expose, or Exec.");
			}
		}),
	});

	RegisterTool({
		name: "PiMnemonicWarm",
		label: "Pi Mnemonic Warm",
		description: "Bump hit counts for named registers (or current hot registers) and return a compact warm context.",
		parameters: Type.Object({ Keys: Type.Optional(Type.Array(Type.String())) }),
		execute: Execute((params: AnyRecord) => {
			const current = GetStore();
			current.warm((params.Keys as string[]) || current.hot().registers.map((r) => r.name));
			Flush();
			return Result(BuildContext(current), { warm: true });
		}),
	});

	RegisterTool({
		name: "PiMnemonicRecall",
		label: "Pi Mnemonic Recall",
		description: "Associative recall of registers, facts, episodes, and techniques using token overlap, exact-phrase boost, hits, and recency. No embedding DB.",
		promptSnippet: "Recall a technique or prior finding by association instead of searching the transcript",
		parameters: Type.Object({
			Query: Type.String({ description: "Natural-language query or keywords" }),
			Limit: Type.Optional(Type.Number({ description: "Max hits (1-20), default 8" })),
		}),
		execute: Execute((params: AnyRecord) => {
			const hits = GetStore().Recall(String(params.Query), Number(params.Limit || 8));
			return Result(hits.length ? JSON.stringify(hits, null, 2) : "No associated memory found. Try PiMnemonicList or rephrase the query.", { hits });
		}),
	});

	RegisterTool({
		name: "PiMnemonicCodify",
		label: "Pi Mnemonic Codify",
		description: "Persist a reusable technique discovered during work. Kind: Register, Technique, Tool, or Skill. Technique/Tool create deterministic callable commands; Skill writes a SKILL.md.",
		promptSnippet: "Turn a reusable trajectory or new capability into a tool, technique, register, or skill",
		promptGuidelines: ["Use PiMnemonicCodify when you notice a reusable trajectory or technique so future sessions start warm instead of rediscovering it."],
		parameters: Type.Object({
			Kind: StringEnum(["Register", "Technique", "Tool", "Skill", "AgentRule"] as const),
			Name: Type.String({ description: "Short key/skill/technique name" }),
			Summary: Type.String({ description: "One-line generalizable statement or description" }),
			Detail: Type.Optional(Type.String({ description: "Longer notes or skill body" })),
			Command: Type.Optional(Type.String({ description: "Deterministic command for Technique/Tool" })),
			Tags: Type.Optional(Type.Array(Type.String())),
			Params: Type.Optional(Type.Array(Type.String())),
			Expose: Type.Optional(Type.Boolean()),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const current = GetStore();
			const kind = String(params.Kind);
			const name = String(params.Name || "").trim();
			const summary = String(params.Summary || "").trim();
			if (!name || !summary) throw new MnemonicError("Codify requires Name and Summary.", "Example: { Kind:'Technique', Name:'safe-xvfb', Summary:'Use xvfb-run with GLX disabled', Command:'...' }");
			const tags = [...new Set([...((params.Tags as string[]) || []), "technique", kind.toLowerCase()])];
			current.learn(summary, tags, 0.9, "PiMnemonicCodify");
			current.note(`Codified ${kind}: ${name}`, summary, tags);
			if (kind === "Register") {
				current.set(name, String(params.Detail || summary), tags);
				Flush();
				return Result(`Stored register ${name}. Recall it with PiMnemonicRecall.`, { kind, name });
			}
			if (kind === "Technique" || kind === "Tool") {
				if (!params.Command) throw new MnemonicError("Technique/Tool requires Command.", "Provide a deterministic shell command with {{mustache}} parameters.");
				const technique = current.techniqueAdd({
					name: SkillName(name).replace(/-/g, "_"),
					command: String(params.Command),
					description: summary,
					usage: String(params.Detail || `Call PiTechnique Exec ${name} with Vars.`),
					params: (params.Params as string[]) || [],
					cwd: ctx?.cwd,
					tags,
					expose: kind === "Tool" || params.Expose === true,
				});
				Flush();
				if (technique.expose) RegisterTechniqueTools();
				return Result(`Codified ${kind} ${technique.name}. ${technique.expose ? `Generated tool PiTechnique${ToPascal(technique.name)}.` : "Call Expose later to generate a tool."}`, { kind, name: technique.name });
			}
			if (kind === "AgentRule" || kind === "Skill") {
				if (!(await OperatorConfirm(ctx, `Allow writing persistent ${kind} memory?`))) throw new MnemonicError("Operator confirmation required.", "Global memory writes are operator-controlled.");
			}
			if (kind === "AgentRule") {
				const key = `rule.${SkillName(name).replace(/-/g, "_")}`;
				current.set(key, summary, tags);
				const file = AppendAgentRule(key, summary);
				Flush();
				return Result(`Promoted to ${file} using {{${key}}}.`, { kind, key, file });
			}
			const slug = SkillName(name);
			const skillFile = WriteSkillFile(slug, summary, String(params.Detail || ""), params.Command ? String(params.Command) : undefined, tags);
			Flush();
			return Result(`Wrote skill ${skillFile}. Use /skill:${slug} or wait for automatic routing.`, { kind, file: skillFile });
		}),
	});

	RegisterTool({
		name: "PiMnemonicLink",
		label: "Pi Mnemonic Link",
		description: "Warm markdown references into cached hints, or weave a Related section linking a document to neighboring markdown files.",
		promptSnippet: "Warm a markdown file's references or link a document to neighboring docs",
		parameters: Type.Object({
			Action: StringEnum(["Warm", "Weave"] as const),
			Path: Type.String({ description: "Markdown file path" }),
			Depth: Type.Optional(Type.Number({ description: "Local markdown link depth, 0-3 (default 1)" })),
			MaxLinks: Type.Optional(Type.Number({ description: "Max Related links to weave (default 10)" })),
		}),
		execute: Execute(async (params: AnyRecord, _signal?: AbortSignal, ctx?: any) => {
			const rawPath = String(params.Path || "").replace(/^@/, "");
			const file = path.resolve(rawPath);
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MnemonicError(`Markdown file not found: ${file}`, "Pass an existing local markdown file path.");
			if (!/\.md$/i.test(file)) throw new MnemonicError("PiMnemonicLink requires a .md file.", "Point Path at a markdown document.");
			if (String(params.Action) === "Weave") {
				if (!(await OperatorConfirm(ctx, "Allow appending a Related section to this markdown file?"))) throw new MnemonicError("Operator confirmation required.", "Weave mutates the target file.");
				const result = WeaveRelatedLinks(file, Number(params.MaxLinks || 10), ctx?.cwd);
				Flush();
				return Result(`Woven ${result.added.length} links into ${result.file}.`, result);
			}
			const text = fs.readFileSync(file, "utf8").slice(0, 200_000);
			const links = WarmMarkdownLinks(GetStore(), text, file, Number(params.Depth ?? 1), ctx?.cwd);
			Flush();
			return Result(links.length ? JSON.stringify(links, null, 2) : "No markdown links found.", { links });
		}),
	});

	const EvidenceFromStore = (focus: string, limit = 8): Evidence[] => GetStore().Recall(focus, limit) as Evidence[];
	const MetaStructured = async (ctx: any, system: string, prompt: string, fallback: Record<string, unknown>, schema: any, _requiredKey: string, signal?: AbortSignal) => {
		const structured = await PromptStructured(ctx, system, prompt, 900, signal);
		if (!structured) return fallback;
		const merged = { ...fallback, ...structured };
		try {
			return Value.Check(schema, merged) ? merged : fallback;
		} catch {
			return fallback;
		}
	};
	const MetaRemember = (summary: string, detail: string, tags: string[]) => {
		GetStore().learn(summary, tags, 0.7, "meta");
		GetStore().note(summary, detail, tags);
		Flush();
	};

	const ReflectConfig = () => {
		const current = GetStore();
		const rawPatterns = current.peek("reflect.patterns");
		return {
			Patterns: Array.isArray(rawPatterns) ? (rawPatterns as string[]).filter((p) => typeof p === "string") : DEFAULT_REFLECT_PATTERNS,
			EveryNTurns: Number(current.peek("reflect.everyNTurns") ?? 12),
			ContextThreshold: Number(current.peek("reflect.contextPercent") ?? 75),
			ToolRepeatThreshold: Number(current.peek("reflect.toolRepeatThreshold") ?? 5),
			CooldownTurns: Number(current.peek("reflect.cooldownTurns") ?? 6),
			Enabled: current.peek("reflect.enabled") !== false,
		};
	};

	const RunReflection = async (ctx: any, focus: string, intelligent = true, reasons: string[] = [], manual = false, signal?: AbortSignal) => {
		const current = GetStore();
		const deterministic = DeterministicReflection({ Focus: focus, Reasons: reasons, LastResponse: String(transientResponse || ""), ContextPercent: ctx?.getContextUsage?.()?.percent ?? null, ToolRepeats: Number(current.peek("reflect.toolRepeats") ?? 0) });
		let result: ReflectResult = deterministic;
		if (intelligent) {
			const structured = await PromptStructured(
				ctx,
				PromptText("PiReflect"),
				`Focus: ${focus}\nTriggers: ${reasons.join("; ") || "manual"}\nHeuristic assessment: ${JSON.stringify(deterministic)}`,
				900,
				signal,
			);
			if (structured && typeof structured.Guidance === "string") {
				result = {
					Verdict: (["Continue", "Scope", "Reset", "Plan", "Exit"].includes(String(structured.Verdict)) ? structured.Verdict : deterministic.Verdict) as ReflectResult["Verdict"],
					Useful: typeof structured.Useful === "boolean" ? structured.Useful : deterministic.Useful,
					Rational: typeof structured.Rational === "boolean" ? structured.Rational : deterministic.Rational,
					Aligned: typeof structured.Aligned === "boolean" ? structured.Aligned : deterministic.Aligned,
					Novelty: (["low", "medium", "high"].includes(String(structured.Novelty)) ? structured.Novelty : deterministic.Novelty) as ReflectResult["Novelty"],
					Risks: Array.isArray(structured.Risks) ? structured.Risks.map(String).slice(0, 5) : deterministic.Risks,
					Guidance: String(structured.Guidance).slice(0, 500),
					NextAction: String(structured.NextAction || deterministic.NextAction).slice(0, 500),
					InjectedPrompt: String(structured.InjectedPrompt || deterministic.InjectedPrompt).slice(0, 500),
					StopConditions: Array.isArray(structured.StopConditions) ? structured.StopConditions.map(String).slice(0, 6) : deterministic.StopConditions,
					Evidence: Array.isArray(structured.Evidence) ? structured.Evidence.map(String).slice(0, 8) : deterministic.Evidence,
					Confidence: Math.max(0, Math.min(1, Number(structured.Confidence ?? deterministic.Confidence))),
				};
			}
		}
		current.set("reflect.pending", result, ["reflect", "pending"]);
		current.set("reflect.lastGuidance", result, ["reflect"]);
		current.set("reflect.lastAt", Date.now(), ["reflect"]);
		current.set("reflect.turnsSinceReflect", 0, ["reflect"]);
		Flush();
		pi.events.emit("pi-mnemonic:reflected", { verdict: result.Verdict, manual, reasons });
		return result;
	};

	RegisterTool({
		name: "PiAssociate",
		label: "Pi Associate",
		description: "Passive session association. Toggle on/off or inspect status. When on, prompts and responses are matched against prior sessions to surface useful experience.",
		parameters: Type.Object({
			Action: StringEnum(["On", "Off", "Status", "Analyze"] as const),
			Query: Type.Optional(Type.String()),
			Intelligent: Type.Optional(Type.Boolean()),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "Status");
			const current = GetStore();
			if (action === "On" || action === "Off") {
				current.set("associate.enabled", action === "On", ["associate"]);
				Flush();
				return Result(`Passive association ${action.toLowerCase()}.`);
			}
			if (action === "Analyze") {
				const query = String(params.Query || transientPrompt || "");
				const candidates = current.Recall(query, 4);
				const structured = params.Intelligent !== false ? await PromptStructured(
					ctx,
					PromptText("PiAssociate"),
					`Current work:\n${query}\n\nRecalled prior work:\n${JSON.stringify(candidates, null, 2)}`,
				) : undefined;
				if (structured) {
					current.learn(`Association lesson: ${String(structured.Lesson || "")}`, ["association"], 0.7, "PiAssociate");
					Flush();
					return Result(JSON.stringify(structured, null, 2), { structured }, structured);
				}
				const fallback = {
					Relevance: candidates.length ? 0.6 : 0,
					WhatWorked: candidates.find((h) => /verified|fixed|passed/i.test(h.Text))?.Text || "No explicit success found.",
					WhatFailed: candidates.find((h) => /failed|error|crash|timeout/i.test(h.Text))?.Text || "No explicit failure found.",
					Trajectory: candidates.map((h) => h.Kind).join(" → ") || "No trajectory found.",
					Outcome: candidates[0]?.Text || "No prior outcome found.",
					Lesson: candidates[0] ? `Reconsider: ${candidates[0].Text}` : "No transferable lesson found.",
					ShouldUse: candidates.length > 0,
				};
				return Result(JSON.stringify(fallback, null, 2), { structured: fallback }, fallback);
			}
			const enabled = current.peek("associate.enabled") !== false;
			return Result(JSON.stringify({ Enabled: enabled, Command: "/pi-mnemonic-associate on|off|status|analyze" }));
		}),
	});

	RegisterTool({
		name: "PiDream",
		label: "Pi Dream",
		description: "Idle knowledge miner namespace. Run a pass, inspect status, promote high-confidence rules to AGENTS.md, or configure the miner.",
		parameters: Type.Object({
			Action: StringEnum(["Run", "Status", "Promote", "Config"] as const),
			MaxSessions: Type.Optional(Type.Number()),
			Promote: Type.Optional(Type.Boolean()),
			Intelligent: Type.Optional(Type.Boolean()),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "Status");
			const current = GetStore();
			if (params.MaxSessions !== undefined) {
				current.set("dream.maxSessions", Math.max(1, Math.min(BACKGROUND_MAX_SESSIONS, Number(params.MaxSessions))), ["dream"]);
				Flush();
			}
			if (action === "Run") {
				const result = await DreamRun(ctx, params.Promote !== false, true);
				let distilled: Record<string, unknown> | undefined;
				if (params.Intelligent !== false) {
					const candidates = current.Recall("root cause verified fix failure environment operator trajectory", 12);
					distilled = await PromptStructured(
						ctx,
						PromptText("PiDream"),
						JSON.stringify(candidates, null, 2),
						1000,
					);
					if (distilled) {
						for (const fact of Array.isArray(distilled.Facts) ? distilled.Facts.slice(0, 12) : []) {
							if (typeof fact === "string" && fact.trim()) current.learn(fact, ["dream", "distilled"], 0.75, "PiDream");
						}
						for (const skill of Array.isArray(distilled.Skills) ? distilled.Skills.slice(0, 4) : []) {
							if (skill && typeof skill.Name === "string" && typeof skill.Summary === "string") {
								WriteSkillFile(skill.Name, skill.Summary, "Distilled by PiDream.", undefined, ["dream"]);
							}
						}
						Flush();
					}
				}
				const payload = { ...result, Distilled: distilled };
				return Result(JSON.stringify(payload, null, 2), payload, distilled || result);
			}
			if (action === "Promote") {
				const promoted = PromoteFacts(current, 3);
				Flush();
				return Result(promoted.length ? `Promoted ${promoted.join(", ")}` : "No high-confidence facts were promoted.", { promoted });
			}
			if (action === "Config") {
				if (params.Promote !== undefined && !(await OperatorConfirm(ctx, "Allow changing dream auto-promotion?"))) throw new MnemonicError("Operator confirmation required.", "This is an operator-controlled safety setting.");
				current.set("dream.autoPromote", params.Promote === true, ["dream"]);
				Flush();
				return Result(JSON.stringify(current.peek("dream.lastRun") || { autoPromote: params.Promote !== false }));
			}
			return Result(JSON.stringify(current.peek("dream.lastRun") || { status: "no run yet" }));
		}),
	});

	RegisterTool({
		name: "PiPlan",
		label: "Pi Plan",
		description: "Store a bounded plan with steps and constraints, then return associations from prior work that can inform it.",
		parameters: Type.Object({
			Goal: Type.String({ description: "What the plan should achieve" }),
			Steps: Type.Optional(Type.Array(Type.String())),
			Constraints: Type.Optional(Type.Array(Type.String())),
			Tags: Type.Optional(Type.Array(Type.String())),
			Intelligent: Type.Optional(Type.Boolean()),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const goal = String(params.Goal || "").trim();
			if (!goal) throw new MnemonicError("PiPlan requires Goal.", "Example: { Goal:'Migrate launcher tests to private Xvfb', Steps:['...'] }");
			const current = GetStore();
			const key = `plan_${createHash("sha1").update(goal).digest("hex").slice(0, 8)}`;
			current.set(key, { Goal: goal, Steps: (params.Steps as string[]) || [], Constraints: (params.Constraints as string[]) || [] }, ["plan", ...((params.Tags as string[]) || [])]);
			current.note(`Plan: ${goal}`, ((params.Steps as string[]) || []).join(" → "), ["plan"]);
			current.learn(goal, ["plan"], 0.7, "PiPlan");
			const associations = current.Recall(goal, 5);
			let refined: Record<string, unknown> | undefined;
			if (params.Intelligent !== false) {
				refined = await PromptStructured(
					ctx,
					PromptText("PiPlan"),
					`Goal: ${goal}\nSteps: ${JSON.stringify(params.Steps || [])}\nConstraints: ${JSON.stringify(params.Constraints || [])}\nAssociations: ${JSON.stringify(associations)}`,
				);
				if (refined) current.set(key, { Goal: goal, Steps: Array.isArray(refined.Steps) ? refined.Steps : params.Steps || [], Constraints: params.Constraints || [], Risks: refined.Risks, NextActions: refined.NextActions }, ["plan", "refined"]);
			}
			Flush();
			return Result(JSON.stringify({ Key: key, Associations: associations, Refined: refined }, null, 2), { key, refined }, refined || { Key: key, Associations: associations });
		}),
	});

	RegisterTool({
		name: "PiImagine",
		label: "Pi Imagine",
		description: "Speculative counterfactuals: how a session could have gone differently and what lesson is worth keeping for a similar situation.",
		parameters: Type.Object({
			Focus: Type.Optional(Type.String()),
			Limit: Type.Optional(Type.Number()),
			Intelligent: Type.Optional(Type.Boolean()),
		}),
		outputSchema: ScenarioStructuredSchema,
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const current = GetStore();
			const focus = String(params.Focus || transientPrompt || "failure crash timeout stale guess");
			const deterministic = GenerateCounterfactuals(current, focus, Number(params.Limit || 4), false);
			let scenarios: any[] = deterministic;
			if (params.Intelligent !== false) {
				const structured = await PromptStructured(
					ctx,
					PromptText("PiImagine"),
					`Focus: ${focus}\nPrior memories: ${JSON.stringify(current.Recall(focus, 8))}\nTemplate scenarios: ${JSON.stringify(deterministic)}`,
					900,
					signal,
				);
				if (Array.isArray(structured?.Scenarios) && structured.Scenarios.length) {
					scenarios = structured.Scenarios.slice(0, 8).map((entry: any) => ({
						Source: String(entry.Source || "PiImagine"),
						Trigger: String(entry.Trigger || focus),
						Counterfactual: String(entry.Counterfactual || ""),
						Lesson: String(entry.Lesson || ""),
					}));
				}
			}
			for (const scenario of scenarios) {
				current.learn(`Counterfactual lesson: ${scenario.Lesson}`, ["counterfactual", "imagine"], 0.6, "PiImagine");
				current.note(`Imagine: ${scenario.Counterfactual}`, scenario.Lesson, ["counterfactual", "imagine"]);
			}
			Flush();
			const payload = { Scenarios: scenarios };
			return Result(scenarios.length ? JSON.stringify(payload, null, 2) : "No counterfactuals were generated. Add more session facts first.", payload, payload);
		}),
	});

	RegisterTool({
		name: "PiSimulate",
		label: "Pi Simulate",
		description: "Rigorous counterfactuals with Hypothesis, Experiment, and Success criteria derived from prior outcomes.",
		parameters: Type.Object({
			Focus: Type.Optional(Type.String()),
			Limit: Type.Optional(Type.Number()),
			Intelligent: Type.Optional(Type.Boolean()),
		}),
		outputSchema: ScenarioStructuredSchema,
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const current = GetStore();
			const focus = String(params.Focus || transientPrompt || "failure crash timeout stale guess");
			const deterministic = GenerateCounterfactuals(current, focus, Number(params.Limit || 4), true);
			let scenarios: any[] = deterministic;
			if (params.Intelligent !== false) {
				const structured = await PromptStructured(
					ctx,
					PromptText("PiSimulate"),
					`Focus: ${focus}\nPrior memories: ${JSON.stringify(current.Recall(focus, 8))}\nTemplate scenarios: ${JSON.stringify(deterministic)}`,
					900,
					signal,
				);
				if (Array.isArray(structured?.Scenarios) && structured.Scenarios.length) {
					scenarios = structured.Scenarios.slice(0, 8).map((entry: any) => ({
						Source: String(entry.Source || "PiSimulate"),
						Trigger: String(entry.Trigger || focus),
						Counterfactual: String(entry.Counterfactual || ""),
						Lesson: String(entry.Lesson || ""),
						Hypothesis: String(entry.Hypothesis || ""),
						Experiment: String(entry.Experiment || ""),
						Success: String(entry.Success || ""),
					}));
				}
			}
			for (const scenario of scenarios) {
				current.learn(`Hypothesis: ${scenario.Hypothesis}`, ["counterfactual", "simulate", "hypothesis"], 0.65, "PiSimulate");
				current.note(`Simulate: ${scenario.Counterfactual}`, `${scenario.Experiment} Success: ${scenario.Success}`, ["counterfactual", "simulate"]);
			}
			Flush();
			const payload = { Scenarios: scenarios };
			return Result(scenarios.length ? JSON.stringify(payload, null, 2) : "No simulations were generated. Add more session facts first.", payload, payload);
		}),
	});

	const MetaFocusParams = Type.Object({
		Focus: Type.Optional(Type.String()),
		Intelligent: Type.Optional(Type.Boolean()),
	});

	RegisterTool({
		name: "PiPredict",
		label: "Pi Predict",
		description: "Grounded forecast from recalled evidence: trajectory, confidence, base rate, drivers, counter-evidence, and stop conditions.",
		promptSnippet: "Predict the likely outcome of the current trajectory from past evidence",
		parameters: Type.Object({ Focus: Type.Optional(Type.String()), Horizon: Type.Optional(Type.Number()), Intelligent: Type.Optional(Type.Boolean()) }),
		outputSchema: PredictionStructuredSchema,
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const focus = String(params.Focus || GetStore().peek("associate.lastPrompt") || "Current trajectory");
			const evidence = EvidenceFromStore(focus);
			const fallback = Predict(focus, evidence) as unknown as Record<string, unknown>;
			const result = await MetaStructured(ctx, PromptText("PiPredict"), `Focus: ${focus}\nHorizon: ${params.Horizon || "short"}\nEvidence: ${JSON.stringify(evidence)}`, fallback, PredictionStructuredSchema, "Forecast", signal);
			MetaRemember(`Prediction: ${String(result.Forecast).slice(0, 160)}`, JSON.stringify(result).slice(0, 4000), ["prediction", "meta"]);
			return Result(JSON.stringify(result, null, 2), result, result);
		}),
	});

	const RiskExecute = Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
		const focus = String(params.Focus || GetStore().peek("associate.lastPrompt") || "Current trajectory");
		const evidence = EvidenceFromStore(focus);
		const fallback = AssessRisk(focus, evidence, ctx?.getContextUsage?.()?.percent ?? null, Number(GetStore().peek("reflect.toolRepeats") ?? 0)) as unknown as Record<string, unknown>;
		const result = await MetaStructured(ctx, PromptText("PiRiskAssessment"), `Focus: ${focus}\nEvidence: ${JSON.stringify(evidence)}`, fallback, RiskStructuredSchema, "Recommendation", signal);
		MetaRemember(`Risk assessment: ${String(result.Recommendation).slice(0, 160)}`, JSON.stringify(result).slice(0, 4000), ["risk", "meta"]);
		return Result(JSON.stringify(result, null, 2), result, result);
	});

	RegisterTool({
		name: "PiRiskAssessment",
		label: "Pi Risk Assessment",
		description: "Quantitative risk register from past evidence: likelihood, impact, score, mitigations, and stop conditions.",
		parameters: MetaFocusParams,
		outputSchema: RiskStructuredSchema,
		execute: RiskExecute,
	});

	RegisterTool({
		name: "PiAssessment",
		label: "Pi Assessment",
		description: "Alias of PiRiskAssessment.",
		parameters: MetaFocusParams,
		outputSchema: RiskStructuredSchema,
		execute: RiskExecute,
	});

	const QuantExecute = Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
		const focus = String(params.Focus || GetStore().peek("associate.lastPrompt") || "Current trajectory");
		const evidence = EvidenceFromStore(focus);
		const fallback = Quantify(focus, evidence, ctx?.getContextUsage?.()?.percent ?? null, Number(GetStore().peek("reflect.toolRepeats") ?? 0)) as unknown as Record<string, unknown>;
		const result = await MetaStructured(ctx, PromptText("PiQuantify"), `Focus: ${focus}\nMetric: ${String(params.Metric || "")}\nEvidence: ${JSON.stringify(evidence)}`, fallback, QuantStructuredSchema, "Formula", signal);
		MetaRemember(`Quant model: ${focus}`, JSON.stringify(result).slice(0, 4000), ["model", "meta"]);
		return Result(JSON.stringify(result, null, 2), result, result);
	});

	RegisterTool({
		name: "PiQuantify",
		label: "Pi Quantify",
		description: "Turn evidence into a bounded quantitative model with variables, formula, estimate, uncertainty, and next measurement.",
		parameters: Type.Object({ Focus: Type.Optional(Type.String()), Metric: Type.Optional(Type.String()), Intelligent: Type.Optional(Type.Boolean()) }),
		outputSchema: QuantStructuredSchema,
		execute: QuantExecute,
	});

	RegisterTool({
		name: "PiModel",
		label: "Pi Model",
		description: "Alias of PiQuantify.",
		parameters: Type.Object({ Focus: Type.Optional(Type.String()), Metric: Type.Optional(Type.String()), Intelligent: Type.Optional(Type.Boolean()) }),
		outputSchema: QuantStructuredSchema,
		execute: QuantExecute,
	});

	RegisterTool({
		name: "PiHypothesis",
		label: "Pi Hypothesis",
		description: "Turn an assumption into a falsifiable hypothesis with metrics, success criterion, falsifier, and cost.",
		parameters: Type.Object({ Focus: Type.Optional(Type.String()), Claim: Type.Optional(Type.String()), Intelligent: Type.Optional(Type.Boolean()) }),
		outputSchema: HypothesisStructuredSchema,
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const focus = String(params.Focus || GetStore().peek("associate.lastPrompt") || "Current assumption");
			const evidence = EvidenceFromStore(focus);
			const fallback = Hypothesize(focus, evidence) as unknown as Record<string, unknown>;
			if (params.Claim) fallback.Claim = String(params.Claim).slice(0, 400);
			const result = await MetaStructured(ctx, PromptText("PiHypothesis"), `Focus: ${focus}\nClaim: ${String(params.Claim || "")}\nEvidence: ${JSON.stringify(evidence)}`, fallback, HypothesisStructuredSchema, "Null", signal);
			MetaRemember(`Hypothesis: ${String(result.Claim).slice(0, 160)}`, JSON.stringify(result).slice(0, 4000), ["hypothesis", "meta"]);
			return Result(JSON.stringify(result, null, 2), result, result);
		}),
	});

	RegisterTool({
		name: "PiExperiment",
		label: "Pi Experiment",
		description: "Design a bounded experiment, optionally run it through a registered PiTechnique, and record the observation as evidence.",
		parameters: Type.Object({
			Focus: Type.Optional(Type.String()), Hypothesis: Type.Optional(Type.String()), TechniqueName: Type.Optional(Type.String()),
			Vars: Type.Optional(Type.String()), Run: Type.Optional(Type.Boolean()), Intelligent: Type.Optional(Type.Boolean()),
		}),
		outputSchema: ExperimentStructuredSchema,
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const focus = String(params.Focus || GetStore().peek("associate.lastPrompt") || "Current assumption");
			const hypothesis = String(params.Hypothesis || GetStore().peek("reflect.lastGuidance") || `Changing ${focus} may improve the outcome.`);
			const fallback = DesignExperiment(focus, hypothesis, String(params.TechniqueName || "")) as unknown as Record<string, unknown>;
			const result = await MetaStructured(ctx, PromptText("PiExperiment"), `Focus: ${focus}\nHypothesis: ${hypothesis}\nTemplate: ${JSON.stringify(fallback)}`, fallback, ExperimentStructuredSchema, "Steps", signal);
			if (params.Run && params.TechniqueName) {
				const technique = GetStore().techniquePeek(String(params.TechniqueName));
				if (!technique) throw new MnemonicError(`No technique '${params.TechniqueName}'.`, "Add a PiTechnique first or omit Run.");
				GetStore().techniqueGet(technique.name);
				const rendered = RenderTechnique(technique.command, ParseVars(params.Vars as string | undefined));
				const output = await RunCommand(rendered, technique.cwd, 30_000, signal);
				const status = `exit=${output.code}${output.timedOut ? " timedOut=true" : ""}${output.truncated ? " truncated=true" : ""}`;
				result.Observation = `[${status}] ${redactCommand(`${output.stdout}${output.stderr ? ` [stderr] ${output.stderr}` : ""}`)}`.slice(0, 4000);
			}
			MetaRemember(`Experiment: ${String(result.Hypothesis).slice(0, 160)}`, JSON.stringify(result).slice(0, 4000), ["experiment", "meta"]);
			return Result(JSON.stringify(result, null, 2), result, result);
		}),
	});

	const ReflectParams = Type.Object({
		Action: StringEnum(["Run", "Status", "Config", "Enable", "Disable"] as const),
		Focus: Type.Optional(Type.String()),
		Intelligent: Type.Optional(Type.Boolean()),
		EveryNTurns: Type.Optional(Type.Number()),
		ContextPercent: Type.Optional(Type.Number()),
		ToolRepeatThreshold: Type.Optional(Type.Number()),
		CooldownTurns: Type.Optional(Type.Number()),
		Patterns: Type.Optional(Type.Array(Type.String())),
	});

	const ReflectExecute = Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
		const action = String(params.Action || "Status");
		const current = GetStore();
		if (action === "Enable" || action === "Disable") {
			current.set("reflect.enabled", action === "Enable", ["reflect"]);
			Flush();
			return Result(`Reflection ${action.toLowerCase()}d.`);
		}
		if (action === "Config") {
			if (params.EveryNTurns !== undefined) current.set("reflect.everyNTurns", Math.max(1, Number(params.EveryNTurns)), ["reflect"]);
			if (params.ContextPercent !== undefined) current.set("reflect.contextPercent", Math.max(1, Math.min(100, Number(params.ContextPercent))), ["reflect"]);
			if (params.ToolRepeatThreshold !== undefined) current.set("reflect.toolRepeatThreshold", Math.max(2, Number(params.ToolRepeatThreshold)), ["reflect"]);
			if (params.CooldownTurns !== undefined) current.set("reflect.cooldownTurns", Math.max(1, Number(params.CooldownTurns)), ["reflect"]);
			if (Array.isArray(params.Patterns)) current.set("reflect.patterns", params.Patterns.filter((p) => typeof p === "string" && p.length <= 200).slice(0, 16), ["reflect"]);
			Flush();
			return Result(JSON.stringify(ReflectConfig(), null, 2));
		}
		if (action === "Run") {
			const focus = String(params.Focus || transientPrompt || transientResponse || "Current session");
			const result = await RunReflection(ctx, focus, params.Intelligent !== false, ["Manual request"], true, signal);
			return Result(ReflectionToText(result), { ...result }, result);
		}
		return Result(JSON.stringify({
			Config: ReflectConfig(),
			Turns: current.peek("reflect.turns") ?? 0,
			LastGuidance: current.peek("reflect.lastGuidance") || null,
		}, null, 2));
	});

	RegisterTool({
		name: "PiReflect",
		label: "Pi Reflect",
		description: "Conditional metacognition: evaluate whether current work is useful, rational, aligned, novel, and worth continuing; inject objective steering into the next prompt.",
		promptSnippet: "Take a step back and decide whether to continue, scope, reset, plan, or exit",
		promptGuidelines: ["Use PiReflect for a sanity check when work circles, context grows, or priorities and privacy risks need re-evaluation."],
		parameters: ReflectParams,
		outputSchema: ReflectStructuredSchema,
		execute: ReflectExecute,
	});

	RegisterTool({
		name: "PiObserve",
		label: "Pi Observe",
		description: "Alias of PiReflect: observe the current trajectory and inject structured next-turn steering.",
		parameters: ReflectParams,
		outputSchema: ReflectStructuredSchema,
		execute: ReflectExecute,
	});

	const CharterConfig = () => {
		const current = GetStore();
		const rawPatterns = current.peek("charter.patterns");
		return {
			Mode: String(current.peek("charter.mode") || "trigger") as "always" | "trigger" | "periodic" | "off",
			EveryNTurns: Number(current.peek("charter.everyNTurns") ?? 20),
			Patterns: Array.isArray(rawPatterns) ? (rawPatterns as string[]).filter((p) => typeof p === "string") : DEFAULT_CHARTER_PATTERNS,
		};
	};

	RegisterTool({
		name: "PiCharter",
		label: "Pi Charter",
		description: "Show and configure the always-on/conditional/periodic operating charter with links to source material.",
		parameters: Type.Object({
			Action: StringEnum(["Show", "Config", "Enable", "Disable", "Source"] as const),
			Mode: Type.Optional(StringEnum(["always", "trigger", "periodic", "off"] as const)),
			EveryNTurns: Type.Optional(Type.Number()),
		}),
		execute: Execute(async (params: AnyRecord, _signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "Show");
			if ((action === "Enable" || action === "Disable" || action === "Config") && !(await OperatorConfirm(ctx, "Allow changing the operating charter?"))) {
				throw new MnemonicError("Operator confirmation required.", "This is an operator-controlled safety setting.");
			}
			const current = GetStore();
			if (action === "Enable") {
				current.set("charter.mode", params.Mode || "always", ["charter"]);
				Flush();
				return Result(`Charter mode ${current.peek("charter.mode")}.`);
			}
			if (action === "Disable") {
				current.set("charter.mode", "off", ["charter"]);
				Flush();
				return Result("Charter disabled.");
			}
			if (action === "Config") {
				if (params.Mode) current.set("charter.mode", params.Mode, ["charter"]);
				if (params.EveryNTurns !== undefined) current.set("charter.everyNTurns", Math.max(1, Number(params.EveryNTurns)), ["charter"]);
				Flush();
				return Result(JSON.stringify(CharterConfig(), null, 2));
			}
			if (action === "Source") return Result(CHARTER_SOURCES);
			return Result(PromptText("PiCharter"));
		}),
	});

	const PruneConfig = () => {
		const current = GetStore();
		const rawPatterns = current.peek("prune.patterns");
		return {
			Enabled: current.peek("prune.enabled") !== false,
			Auto: current.peek("prune.auto") === true,
			TtlDays: Number(current.peek("prune.ttlDays") ?? 14),
			MaxItems: Number(current.peek("prune.maxItems") ?? 50),
			Patterns: Array.isArray(rawPatterns) ? (rawPatterns as string[]).filter((p) => typeof p === "string") : DEFAULT_PRUNE_PATTERNS,
		};
	};

	RegisterTool({
		name: "PiPrune",
		label: "Pi Prune",
		description: "Move stale, unused, or noisy memory into bounded cold storage. Manual, agent, or tripwire triggered; optional typed decision model.",
		parameters: Type.Object({
			Action: StringEnum(["Preview", "Run", "Restore", "Status", "Config"] as const),
			Key: Type.Optional(Type.String()),
			Focus: Type.Optional(Type.String()),
			Reason: Type.Optional(Type.String()),
			Intelligent: Type.Optional(Type.Boolean()),
			DryRun: Type.Optional(Type.Boolean()),
			TtlDays: Type.Optional(Type.Number()),
			MaxItems: Type.Optional(Type.Number()),
			Patterns: Type.Optional(Type.Array(Type.String())),
			Auto: Type.Optional(Type.Boolean()),
			Decision: Type.Optional(StringEnum(["Fire", "Skip", "Defer"] as const)),
		}),
		execute: Execute(async (params: AnyRecord, signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "Status");
			const current = GetStore();
			const config = PruneConfig();
			if (action === "Config") {
				if (params.TtlDays !== undefined) current.set("prune.ttlDays", Math.max(1, Number(params.TtlDays)), ["prune"]);
				if (params.MaxItems !== undefined) current.set("prune.maxItems", Math.max(1, Math.min(200, Number(params.MaxItems))), ["prune"]);
				if (Array.isArray(params.Patterns)) current.set("prune.patterns", params.Patterns.filter((p) => typeof p === "string" && p.length <= 200).slice(0, 16), ["prune"]);
				if (params.Auto !== undefined) current.set("prune.auto", Boolean(params.Auto), ["prune"]);
				Flush();
				return Result(JSON.stringify(PruneConfig(), null, 2));
			}
			if (action === "Status") return Result(JSON.stringify({ Config: config, Cold: current.coldStats(), LastAt: current.peek("prune.lastAt") || null }, null, 2));
			if (action === "Restore") {
				const restored = current.Restore(String(params.Key || ""));
				Flush();
				return Result(restored ? `Restored ${params.Key}` : `No cold item '${params.Key}'`, { restored });
			}
			const focus = String(params.Focus || transientPrompt || "memory hygiene");
			const candidates = current.PruneCandidates({ ttlDays: config.TtlDays, maxItems: config.MaxItems });
			if (action === "Preview") return Result(candidates.length ? JSON.stringify(candidates, null, 2) : "No prune candidates.", { candidates });
			const trigger = EvaluateTriggers({
				Focus: focus,
				LastResponse: String(transientResponse || ""),
				Patterns: config.Patterns,
				Keywords: ["prune", "noise", "irrelevant", "stale", "context"],
				Manual: true,
				Decision: params.Decision as "Fire" | "Skip" | "Defer" | undefined,
			});
			if (!trigger.Triggered && params.Decision !== "Fire") return Result(JSON.stringify({ skipped: true, reasons: trigger.Reasons }, null, 2));
			let decisions: Record<string, "Prune" | "Keep"> | null = null;
			if (params.Intelligent !== false && candidates.length) {
				const decision = await PromptStructured(ctx, PromptText("PiTriggerDecision"), JSON.stringify({ Focus: focus, Reasons: trigger.Reasons, CandidateCount: candidates.length }), 300, signal);
				const decisionFire = decision?.Fire === true || decision?.Priority === "Fire";
				if (decisionFire === false || decision?.Priority === "Skip") return Result(JSON.stringify({ skipped: true, reason: (decision as AnyRecord | undefined)?.Reason || "Decision model Skip" }, null, 2));
				const structured = await PromptStructured(ctx, PromptText("PiPruneDecision"), JSON.stringify({ Focus: focus, Candidates: candidates.slice(0, 20) }), 600, signal);
				if (!Array.isArray(structured?.Decisions)) return Result(JSON.stringify({ skipped: true, reason: "Prune decision model returned no valid Decisions; nothing was moved." }, null, 2), { error: true, skipped: true });
				decisions = {};
				for (const entry of structured.Decisions as AnyRecord[]) {
					if (entry && typeof entry.Key === "string" && candidates.some((candidate) => candidate.Key === entry.Key)) {
						decisions[entry.Key] = entry.Action === "Keep" ? "Keep" : "Prune";
					}
				}
				if (!Object.keys(decisions).length) return Result(JSON.stringify({ skipped: true, reason: "No valid decisions matched candidates." }, null, 2), { error: true, skipped: true });
			}
			if (params.DryRun) return Result(JSON.stringify({ candidates, decisions }, null, 2));
			const moved = current.Prune(decisions, config.MaxItems, String(params.Reason || "PiPrune"), config.TtlDays);
			current.set("prune.lastAt", Date.now(), ["prune"]);
			current.set("prune.turnsSincePrune", 0, ["prune"]);
			Flush();
			return Result(JSON.stringify({ moved, cold: current.coldStats(), reasons: trigger.Reasons }, null, 2), { moved });
		}),
	});

	RegisterTool({
		name: "PiPrompt",
		label: "Pi Prompt",
		description: "List, read, edit, or reset editable YAML prompt cards for the meta-cognition tools.",
		parameters: Type.Object({
			Action: StringEnum(["List", "Get", "Set", "Reset"] as const),
			Key: Type.Optional(Type.String()),
			Prompt: Type.Optional(Type.String()),
		}),
		execute: Execute(async (params: AnyRecord, _signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "List");
			if (action === "List") {
				return Result(JSON.stringify(PromptKeys().map((key) => ({ Key: key, Source: PromptSource(key) })), null, 2));
			}
			const key = String(params.Key || "");
			if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROMPTS, key)) throw new MnemonicError(`Unknown editable prompt key '${key}'.`, "Call PiPrompt List to see editable keys.");
			if (action === "Get") return Result(PromptText(key), { key });
			if ((action === "Set" || action === "Reset") && !(await OperatorConfirm(ctx, "Allow editing operator prompt cards?"))) throw new MnemonicError("Operator confirmation required.", "Prompt cards are operator-owned configuration.");
			if (action === "Set") {
				if (!params.Prompt) throw new MnemonicError("Set requires Prompt.", "Provide the replacement system prompt text.");
				const file = WritePromptCard(key, String(params.Prompt));
				return Result(`Wrote ${file}`, { key, file });
			}
			const file = ResetPromptCard(key);
			return Result(`Reset ${key} to default in ${file}`, { key, file });
		}),
	});

	RegisterTool({
		name: "PiStats",
		label: "Pi Stats",
		description: "Dump extension stats and export bounded usage rows to JSON/JSONL/eval/LangSmith/Langfuse/OTel formats. Opt-in observability.",
		parameters: Type.Object({
			Action: StringEnum(["Dump", "Enable", "Disable", "Export", "Query", "Reset"] as const),
			Format: Type.Optional(StringEnum(["json", "jsonl", "eval", "langsmith", "langfuse", "otel"] as const)),
			Path: Type.Optional(Type.String()),
			Limit: Type.Optional(Type.Number()),
			SinceMs: Type.Optional(Type.Number()),
		}),
		execute: Execute(async (params: AnyRecord, _signal?: AbortSignal, ctx?: any) => {
			const action = String(params.Action || "Dump");
			const current = GetStore();
			if (action === "Enable" || action === "Disable") {
				if (!(await OperatorConfirm(ctx, "Allow changing opt-in observability?"))) throw new MnemonicError("Operator confirmation required.", "Usage recording is opt-in.");
				current.set("observability.enabled", action === "Enable", ["observability"]);
				Flush();
				return Result(`Usage recording ${action === "Enable" ? "enabled" : "disabled"}.`);
			}
			if (action === "Reset") {
				if (!(await OperatorConfirm(ctx, "Allow clearing usage history?"))) throw new MnemonicError("Operator confirmation required.", "Reset deletes bounded usage rows.");
				const removed = current.ClearUsage();
				Flush();
				return Result(`Cleared ${removed} usage rows.`);
			}
			const since = Number(params.SinceMs || 0);
			const limit = Math.max(1, Math.min(CAPS.usage, Number(params.Limit || 200)));
			if (action === "Query") {
				const rows = current.UsageRows(limit).filter((row) => row.At >= since);
				return Result(JSON.stringify(rows, null, 2), { rows });
			}
			if (action === "Export") {
				const format = String(params.Format || "json");
				if (params.Path && !(await OperatorConfirm(ctx, "Allow writing usage export to disk?"))) throw new MnemonicError("Operator confirmation required.", "Exports can contain operational metadata.");
				const data = current.ExportUsage(format, limit);
				const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
				if (params.Path) {
					const file = path.resolve(String(params.Path).replace(/^@/, ""));
					fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
					fs.writeFileSync(file, text, { mode: 0o600 });
					return Result(`Exported ${format} to ${file}`, { file, format, rows: Array.isArray(data) ? data.length : 1 });
				}
				return Result(text, { format, data });
			}
			return Result(JSON.stringify({ Config: current.peek("observability.enabled") === true, Store: current.stats(), Usage: current.UsageStats() }, null, 2));
		}),
	});

	RegisterTool({
		name: "PiMnemonicStats",
		label: "Pi Mnemonic Stats",
		description: "Show store counts, file path, and caps.",
		parameters: Type.Object({}),
		execute: Execute(() => Result(JSON.stringify(GetStore().stats(), null, 2))),
	});

	pi.on("session_start", async (_event, ctx) => {
		store = new MnemonicStore();
		const initial = store.stats();
		const empty = Number(initial.registers) === 0 && Number(initial.facts) === 0 && Number(initial.episodes) === 0 && Number(initial.techniques) === 0 && Number(initial.paths) === 0 && Number(initial.commands) === 0;
		try {
			if (!empty) throw new Error("non-empty store; skip compact merge");
			const entries = ctx.sessionManager.getBranch();
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as unknown as AnyRecord;
				if ((entry as AnyRecord).type === "custom" && (entry as AnyRecord).customType === "pi-mnemonic-compact") {
					store.mergeCompact(entry.data);
					break;
				}
			}
		} catch {
			// A compact snapshot is an optimization; a fresh store is still valid.
		}
		store.pathHit(ctx.cwd);
		store.flush();
		RegisterTechniqueTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const contextStarted = Date.now();
		const current = GetStore();
		event.systemPromptOptions.sections[ContextSectionName()] = BuildContext(current, 4000);
		const promptText = event.messageType === "user"
			? event.prompt
			: (typeof (event.message as unknown as AnyRecord)?.content === "string" ? String((event.message as unknown as AnyRecord).content) : "");
		event.systemPromptOptions.sections[RecallSectionName()] = BuildAssociations(current, promptText, 1200);
		if (current.peek("associate.enabled") !== false) {
			transientPrompt = promptText.slice(0, 1200); transientAt = Date.now();
			const lastResponse = String(transientResponse || "");
			const association = BuildAssociateContext(current, promptText, lastResponse);
			const cold = current.ColdRecall(promptText, 5, Number(current.peek("associate.promoteThreshold") ?? 5));
			event.systemPromptOptions.sections[AssociateSectionName()] = [association, cold.Promoted.length ? `Promoted from cold storage after repeated association: ${cold.Promoted.join(", ")}.` : ""].filter(Boolean).join("\n");
		} else {
			event.systemPromptOptions.sections[AssociateSectionName()] = "";
		}
		const reflectConfig = ReflectConfig();
		if (!reflectConfig.Enabled) {
			event.systemPromptOptions.sections["pi-mnemonic-reflect"] = "";
			if (current.peek("reflect.pending")) {
				current.delete("reflect.pending");
				Flush();
			}
		} else {
			const pending = current.peek("reflect.pending") as ReflectResult | undefined;
			let reflection = pending && typeof pending.Guidance === "string" ? pending : undefined;
			if (!reflection) {
				const trigger = EvaluateTriggers({
					Focus: promptText,
					LastResponse: String(transientResponse || transientResponse || ""),
					Patterns: reflectConfig.Patterns,
					EveryNTurns: reflectConfig.EveryNTurns,
					Turns: Number(current.peek("reflect.turns") ?? 0),
					TurnsSince: Number(current.peek("reflect.turnsSinceReflect") ?? 0),
					ContextPercent: ctx?.getContextUsage?.()?.percent ?? null,
					ContextThreshold: reflectConfig.ContextThreshold,
					ToolRepeats: Number(current.peek("reflect.toolRepeats") ?? 0),
					ToolRepeatThreshold: reflectConfig.ToolRepeatThreshold,
					CooldownTurns: reflectConfig.CooldownTurns,
					Manual: false,
				});
				if (trigger.Triggered) reflection = await RunReflection(ctx, promptText, true, trigger.Reasons, false, ctx?.signal);
			}
			event.systemPromptOptions.sections["pi-mnemonic-reflect"] = reflection ? ReflectionToInnerText(reflection) : "";
			if (reflection) {
				current.delete("reflect.pending");
				Flush();
			}
		}
		const contextPercent = ctx?.getContextUsage?.()?.percent ?? null;
		const repeats = Number(current.peek("reflect.toolRepeats") ?? 0);
		const metaTrigger = EvaluateTriggers({
			Focus: promptText,
			LastResponse: String(transientResponse || ""),
			ContextPercent: contextPercent,
			ContextThreshold: 80,
			ToolRepeats: repeats,
			ToolRepeatThreshold: 5,
			TurnsSince: Number(current.peek("reflect.turnsSinceReflect") ?? 0),
			CooldownTurns: 6,
			Manual: false,
		});
		if (current.peek("meta.auto") === true && metaTrigger.Triggered) {
			const risk = AssessRisk(promptText, EvidenceFromStore(promptText, 6), contextPercent, repeats);
			event.systemPromptOptions.sections["pi-mnemonic-meta"] = [
				`Quantitative tripwire: risk ${risk.RiskScore}/100, likelihood ${risk.Likelihood}/5, impact ${risk.Impact}/5.`,
				risk.Recommendation,
				`Stop when: ${risk.StopConditions.join("; ")}`,
			].join("\n");
		} else {
			event.systemPromptOptions.sections["pi-mnemonic-meta"] = "";
		}
		const pruneConfig = PruneConfig();
		if (pruneConfig.Enabled && pruneConfig.Auto) {
			const pruneTrigger = EvaluateTriggers({
				Focus: promptText,
				LastResponse: String(transientResponse || ""),
				Patterns: pruneConfig.Patterns,
				Keywords: ["prune", "noise", "irrelevant", "stale", "context"],
				Turns: Number(current.peek("prune.turns") ?? 0),
				TurnsSince: Number(current.peek("prune.turnsSincePrune") ?? 0),
				EveryNTurns: 20,
				ContextPercent: contextPercent,
				ContextThreshold: 85,
				ToolRepeats: repeats,
				ToolRepeatThreshold: 6,
				CooldownTurns: 6,
				Manual: false,
			});
			if (pruneTrigger.Triggered) {
				const moved = current.Prune(null, pruneConfig.MaxItems, "auto-trigger", pruneConfig.TtlDays);
				current.set("prune.lastAt", Date.now(), ["prune"]);
				current.set("prune.turnsSincePrune", 0, ["prune"]);
				event.systemPromptOptions.sections["pi-mnemonic-prune"] = moved.length
					? `Moved ${moved.length} stale/noisy items to cold storage (${pruneTrigger.Reasons.slice(0, 3).join("; ")}). Restore with PiPrune Restore Key.`
					: "Prune trigger fired but no stale items qualified.";
				Flush();
			} else {
				event.systemPromptOptions.sections["pi-mnemonic-prune"] = "";
			}
		} else {
			event.systemPromptOptions.sections["pi-mnemonic-prune"] = "";
		}
		const charter = CharterConfig();
		if (charter.Mode === "always") {
			event.systemPromptOptions.sections["pi-mnemonic-charter"] = PromptText("PiCharter");
		} else if (charter.Mode === "periodic") {
			const since = Number(current.peek("charter.turnsSince") ?? 0);
			event.systemPromptOptions.sections["pi-mnemonic-charter"] = since >= charter.EveryNTurns ? PromptText("PiCharter") : "";
			if (since >= charter.EveryNTurns) current.set("charter.turnsSince", 0, ["charter"]);
		} else if (charter.Mode === "trigger") {
			const trigger = EvaluateTriggers({
				Focus: promptText,
				LastResponse: String(transientResponse || ""),
				Patterns: charter.Patterns,
				Keywords: ["sanctioned", "OFAC", "SDN", "embargo", "export control", "denied party", "restricted party"],
				Manual: false,
			});
			let fire = trigger.Triggered;
			if (fire && current.peek("charter.confirm") !== false) {
				const decision = await PromptStructured(ctx, PromptText("PiTriggerDecision"), JSON.stringify({ Focus: promptText, Reasons: trigger.Reasons, Rule: "fire only for sanctioned individuals/organizations or sanctions/export-control compliance work" }), 300, ctx?.signal);
				if (decision?.Fire === false || decision?.Priority === "Skip") fire = false;
			}
			event.systemPromptOptions.sections["pi-mnemonic-charter"] = fire ? PromptText("PiCharter") : "";
		} else {
			event.systemPromptOptions.sections["pi-mnemonic-charter"] = "";
		}
		for (const file of event.systemPromptOptions.contextFiles) {
			if (!/\.md$/i.test(file.path) || file.content.length > 200_000) continue;
			const rendered = RenderMarkdown(ApplyPinTokens(file.content, String(event.systemPromptOptions.cwd || ctx.cwd)), StoreVariables());
			if (rendered !== file.content) file.content = rendered;
			WarmMarkdownLinks(current, rendered, file.path, 1, String(event.systemPromptOptions.cwd || ctx.cwd));
		}
		event.systemPromptOptions.sections[LinkSectionName()] = BuildLinkHints(current);
		current.pathHit(event.systemPromptOptions.cwd || ctx.cwd);
		if (ObserveEnabled()) {
			const sections = event.systemPromptOptions.sections as Record<string, string | null>;
			const sectionBytes = Object.entries(sections).reduce((sum, [name, value]) => sum + (name.startsWith("pi-mnemonic") ? Buffer.byteLength(value || "", "utf8") : 0), 0);
			current.RecordUsage({
				Tool: "context", Action: "before_agent_start", DurationMs: Date.now() - contextStarted,
				Success: true, InputBytes: Buffer.byteLength(promptText, "utf8"), OutputBytes: sectionBytes,
				Model: String(ctx?.model?.id || ""), Meta: { source: "hook", sections: Object.keys(sections).filter((name) => name.startsWith("pi-mnemonic")) },
			});
		}
		Flush();
	});

	pi.on("tool_call", async (event) => {
		if (!store || event.toolName !== "bash") return;
		const command = (event.input as AnyRecord | undefined)?.command;
		if (typeof command === "string" && command.trim()) store.commandHit(command);
	});

	pi.on("session_before_compact", async () => {
		const current = GetStore();
		Flush();
		pi.appendEntry("pi-mnemonic-compact", current.compactSnapshot());
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!ObserveEnabled()) return;
		const raw = event as unknown as AnyRecord;
		GetStore().RecordUsage({
			Tool: String(raw.toolName || "builtin"),
			Action: "execute",
			DurationMs: Number(raw.durationMs) || 0,
			Success: !raw.isError,
			ErrorCode: raw.error ? String((raw.error as AnyRecord)?.name || "error") : undefined,
			InputBytes: ByteCount(raw.input),
			OutputBytes: ByteCount(raw.result),
			Model: String(ctx?.model?.id || ""),
			Meta: { source: "tool_execution_end" },
		});
		Flush();
	});

	pi.on("agent_end", async (event) => {
		const current = GetStore();
		const response = MessageText((event as unknown as AnyRecord).messages);
		transientResponse = response || ""; transientAt = Date.now();
		if (current.peek("associate.enabled") !== false && response) transientResponse = response; transientAt = Date.now();
		Flush();
	});

	pi.on("turn_end", async (event) => {
		const current = GetStore();
		if (ReflectConfig().Enabled) {
			const turns = Number(current.peek("reflect.turns") ?? 0) + 1;
			const since = Number(current.peek("reflect.turnsSinceReflect") ?? 0) + 1;
			current.set("reflect.turns", turns, ["reflect"]);
			current.set("reflect.turnsSinceReflect", since, ["reflect"]);
		}
		if (PruneConfig().Enabled) {
			current.set("prune.turns", Number(current.peek("prune.turns") ?? 0) + 1, ["prune"]);
			current.set("prune.turnsSincePrune", Number(current.peek("prune.turnsSincePrune") ?? 0) + 1, ["prune"]);
		}
		current.set("charter.turnsSince", Number(current.peek("charter.turnsSince") ?? 0) + 1, ["charter"]);
		const toolResults = (event as unknown as AnyRecord).toolResults;
		if (Array.isArray(toolResults) && toolResults.length) {
			const name = String((toolResults[toolResults.length - 1] as AnyRecord)?.toolName || "");
			const lastTool = String(current.peek("reflect.lastTool") || "");
			const repeats = name && name === lastTool ? Number(current.peek("reflect.toolRepeats") ?? 0) + 1 : 1;
			current.set("reflect.lastTool", name, ["reflect"]);
			current.set("reflect.toolRepeats", repeats, ["reflect"]);
		}
		Flush();
	});

	pi.on("agent_settled", async (event, ctx) => {
		if ((event as unknown as AnyRecord).aborted) return;
		await DreamRun(ctx, GetStore().peek("dream.autoPromote") === true);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		Flush();
	});

	pi.registerCommand("pi-mnemonic-stats", {
		description: "Dump usage stats or export: /pi-mnemonic-stats [json|jsonl|eval|langsmith|langfuse|otel] [path]",
		handler: async (args, ctx) => {
			const [arg, outPath] = args.trim().split(/\s+/);
			const current = GetStore();
			if (arg === "enable" || arg === "disable") {
				if (!(await OperatorConfirm(ctx, "Allow changing opt-in observability?"))) return;
				current.set("observability.enabled", arg === "enable", ["observability"]);
				Flush();
				ctx.ui.notify(`Usage recording ${arg}d.`, "info");
				return;
			}
			if (arg && outPath && !(await OperatorConfirm(ctx, "Allow writing usage export to disk?"))) return;
			const data = current.ExportUsage(arg || "json", 200);
			const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
			if (outPath) {
				const file = path.resolve(outPath.replace(/^@/, ""));
				fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(file, text, { mode: 0o600 });
				ctx.ui.notify(`Exported to ${file}`, "info");
				return;
			}
			ctx.ui.notify(`Usage rows: ${Number(current.stats().usageRows)}; stats dumped to session.`, "info");
			pi.sendMessage({ customType: "pi-mnemonic-stats", content: JSON.stringify({ Store: current.stats(), Usage: current.UsageStats(), Export: text.slice(0, 20_000) }, null, 2), display: true });
		},
	});

	pi.registerCommand("pi-mnemonic-help", {
		description: "Show the PiMnemonic tool API and examples",
		handler: async () => {
			pi.sendMessage({ customType: "pi-mnemonic-help", content: HelpText(), display: true });
		},
	});

	pi.registerCommand("pi-mnemonic-status", {
		description: "Show PiMnemonic store counts and caps",
		handler: async (_args, ctx) => {
			const stats = GetStore().stats();
			ctx.ui.notify(`PiMnemonic: ${stats.registers} registers, ${stats.facts} facts, ${stats.episodes} episodes, ${stats.techniques} techniques`, "info");
		},
	});

	pi.registerCommand("pi-mnemonic-reflect", {
		description: "Run a metacognitive step-back check: /pi-mnemonic-reflect [focus]",
		handler: async (args, ctx) => {
			const focus = args.trim() || String(GetStore().peek("associate.lastPrompt") || "Current session");
			const result = await RunReflection(ctx, focus, true, ["Manual slash command"], true, ctx?.signal);
			ctx.ui.notify(`PiReflect: ${result.Verdict} — ${result.NextAction}`, "info");
		},
	});

	pi.registerCommand("pi-mnemonic-associate", {
		description: "Toggle passive session association: /pi-mnemonic-associate on|off|status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				GetStore().set("associate.enabled", action === "on", ["associate"]);
				Flush();
				ctx.ui.notify(`Passive association ${action}`, "info");
				return;
			}
			ctx.ui.notify(`Passive association: ${GetStore().peek("associate.enabled") !== false ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("pi-mnemonic-warm", {
		description: "Warm registers: /pi-mnemonic-warm Key,Key",
		handler: async (args) => {
			const current = GetStore();
			const keys = args.split(",").map((k: string) => k.trim()).filter(Boolean);
			current.warm(keys.length ? keys : current.hot().registers.map((r) => r.name));
			Flush();
			pi.sendMessage({ customType: "pi-mnemonic-warm", content: BuildContext(current), display: true });
		},
	});
}
