import { EvaluateTriggers, type TriggerResult } from "./tripwire.ts";
export { EvaluateTriggers } from "./tripwire.ts";
export type { TriggerResult } from "./tripwire.ts";

export type ReflectVerdict = "Continue" | "Scope" | "Reset" | "Plan" | "Exit";

export interface ReflectResult {
	Verdict: ReflectVerdict;
	Useful: boolean;
	Rational: boolean;
	Aligned: boolean;
	Novelty: "low" | "medium" | "high";
	Risks: string[];
	Guidance: string;
	NextAction: string;
	InjectedPrompt: string;
	StopConditions: string[];
	Evidence: string[];
	Confidence: number;
}

export const DEFAULT_REFLECT_PATTERNS = [
	"run aground|going in circles|stuck|spinning|yakshav|waste of time|not useful|why are we|what are we doing",
	"reset|compact|start over|step back|sanity check|reflect|regret",
	"privacy|api key|token|password|real name|address|leak",
];

export function DeterministicReflection(input: {
	Focus: string;
	Reasons: string[];
	LastResponse?: string;
	ContextPercent?: number | null;
	ToolRepeats: number;
}): ReflectResult {
	const text = `${input.Focus}\n${input.LastResponse || ""}`;
	const privacy = /privacy|api key|token|password|real name|address|leak/i.test(text);
	const circling = /circl|stuck|run aground|yakshav|waste|why are we|not useful/i.test(text);
	const novelty = /new|novel|first time|unexplored|discover|uncovered/i.test(text) ? "high" : "medium";
	const risks: string[] = [];
	let verdict: ReflectVerdict = "Continue";
	let guidance = "The current path looks productive. Keep the next step small and verify the outcome before expanding scope.";
	let nextAction = "State the next concrete check, run it, and record the result.";

	if (privacy) {
		verdict = "Scope";
		risks.push("Privacy or credential exposure language detected. Never copy secrets or personal data into context; use named tokens and redaction.");
		guidance = "Stop and close any privacy gap before continuing. Move secrets to the credential vault and reference them by name.";
		nextAction = "Replace literal secrets/personal data with tokens, then resume the original objective.";
	}
	if (circling || input.ToolRepeats >= 5) {
		verdict = "Plan";
		risks.push("Repeated or circular activity detected.");
		guidance = "You may be going in circles. Write a two-step plan with an exit criterion before running another tool.";
		nextAction = "Summarize what is proven, name the single next test, and set a stop condition.";
	}
	if (input.ContextPercent !== null && input.ContextPercent !== undefined && input.ContextPercent >= 75) {
		risks.push("Context is large; continue with a compact, bounded prompt.");
		if (verdict === "Continue") verdict = "Reset";
		guidance = "Context usage is high. Compact or summarize proven facts before making new decisions.";
		nextAction = "Produce a compact state summary and continue from the verified facts only.";
	}
	if (!risks.length) risks.push("No strong risk signal; avoid speculative expansion.");

	return {
		Verdict: verdict,
		Useful: (verdict as string) !== "Exit",
		Rational: !circling,
		Aligned: !privacy,
		Novelty: novelty,
		Risks: risks.slice(0, 5),
		Guidance: guidance,
		NextAction: nextAction,
		InjectedPrompt: `${guidance} Next: ${nextAction} Stop when: ${["objective achieved", "two failed attempts at the same approach", "new higher-priority risk", "budget or context limit reached"].join("; ")}.`,
		StopConditions: ["Objective achieved", "Two failed attempts at the same approach", "New higher-priority risk appears", "Budget or context limit reached"],
		Evidence: input.Reasons.slice(0, 8),
		Confidence: privacy || circling ? 0.75 : 0.6,
	};
}

export function ReflectionToInnerText(result: ReflectResult): string {
	return [
		`Step back: ${result.Verdict}. ${result.Guidance}`,
		`Next action: ${result.NextAction}`,
		`Next prompt: ${result.InjectedPrompt}`,
		`Risks: ${result.Risks.slice(0, 5).join(" | ") || "(none)"}`,
		`Stop when: ${result.StopConditions.slice(0, 6).join("; ")}`,
		`Evidence: ${result.Evidence.slice(0, 8).join("; ") || "(manual or heuristic)"}`,
	].join("\n");
}

export function ReflectionToText(result: ReflectResult): string {
	return `<pi-mnemonic-reflect>\n${ReflectionToInnerText(result)}\n</pi-mnemonic-reflect>`;
}
