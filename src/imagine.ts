import type { MnemonicStore } from "./store.ts";

export interface Scenario {
	Source: string;
	Trigger: string;
	Counterfactual: string;
	Lesson: string;
	Hypothesis?: string;
	Experiment?: string;
	Success?: string;
}

const RULES: Array<{ test: RegExp; counterfactual: string; lesson: string; experiment: string }> = [
	{
		test: /timeout|hang|abort|stalled|blocked/i,
		counterfactual: "What if the work had been split into bounded steps with a timeout and a checkpoint before this point?",
		lesson: "Cap long-running operations, checkpoint before risky steps, and resume from the last good state.",
		experiment: "Re-run the smallest reproducer with a 30s timeout and one checkpoint; compare recovery time.",
	},
	{
		test: /crash|segfault|abrt|oom|out of memory/i,
		counterfactual: "What if the failing native/GPU component had been isolated in a bounded subprocess with a safe fallback?",
		lesson: "Isolate unstable native paths from the main session and prefer software/offline fallbacks when available.",
		experiment: "Run the same workload with the suspect feature disabled; compare cores and completion.",
	},
	{
		test: /stale|mismatch|abi|version/i,
		counterfactual: "What if dependency and header timestamps had been checked before linking?",
		lesson: "Verify ABI/version freshness before trusting prebuilt artifacts; rebuild from source when in doubt.",
		experiment: "Compare artifact mtime against header mtime, rebuild once, and rerun the failing test.",
	},
	{
		test: /secret|token|password|redact|credential/i,
		counterfactual: "What if values had been referenced by name through a template instead of copied into context?",
		lesson: "Store secrets only in the credential vault and interpolate named tokens at the last moment.",
		experiment: "Replace one literal with a named token and verify the tool call still succeeds without exposing the value.",
	},
	{
		test: /guess|assumed|unverified|workaround/i,
		counterfactual: "What if the risky assumption had been tested with a tiny experiment before acting on it?",
		lesson: "Promote guesses into explicit hypotheses with a bounded test before committing to a fix.",
		experiment: "Write the assumption as a one-line hypothesis and run the smallest discriminating check.",
	},
];

const GENERIC = {
	counterfactual: "What if a smaller, reversible experiment had been run before the decisive change?",
	lesson: "Prefer bounded, reversible steps and record the outcome so future sessions can reuse it.",
	experiment: "Define one observable success criterion, run the smallest safe change, and record the result.",
};

export function GenerateCounterfactuals(store: MnemonicStore, focus: string, limit = 4, rigorous = false): Scenario[] {
	const hits = store.Recall(focus || "failure crash timeout stale guess", Math.max(4, Math.min(12, limit * 2)));
	const scenarios: Scenario[] = [];
	const seen = new Set<string>();
	for (const hit of hits) {
		if (scenarios.length >= Math.max(1, Math.min(8, limit))) break;
		const rule = RULES.find((entry) => entry.test.test(hit.Text)) || { test: /./, ...GENERIC };
		const key = `${rule.counterfactual}|${hit.Key}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const scenario: Scenario = {
			Source: `${hit.Kind}:${hit.Key}`,
			Trigger: hit.Text.slice(0, 180),
			Counterfactual: rule.counterfactual,
			Lesson: rule.lesson,
		};
		if (rigorous) {
			scenario.Hypothesis = `If ${rule.lesson.toLowerCase()} then a similar ${hit.Kind.toLowerCase()} should be resolved faster or avoided.`;
			scenario.Experiment = rule.experiment;
			scenario.Success = "A bounded check completes, the failure does not recur, and the outcome is recorded as a reusable fact.";
		}
		scenarios.push(scenario);
	}
	return scenarios;
}
