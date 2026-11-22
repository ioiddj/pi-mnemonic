export interface Evidence {
	Kind: string;
	Key: string;
	Text: string;
	Score: number;
}

export interface Prediction {
	Focus: string;
	Forecast: string;
	Confidence: number;
	BaseRate: number;
	EvidenceCount: number;
	Drivers: string[];
	CounterEvidence: string[];
	ExpectedOutcome: string;
	StopConditions: string[];
}

export interface RiskAssessment {
	Focus: string;
	RiskScore: number;
	Likelihood: number;
	Impact: number;
	Risks: Array<{ Risk: string; Severity: number; Likelihood: number; Mitigation: string }>;
	Recommendation: string;
	StopConditions: string[];
}

export interface QuantModel {
	Focus: string;
	Variables: Array<{ Name: string; Value: number | string; Unit: string; Source: string }>;
	Formula: string;
	Estimate: string;
	Uncertainty: number;
	DataGaps: string[];
	NextMeasurement: string;
}

export interface Hypothesis {
	Claim: string;
	Null: string;
	Variables: string[];
	Metric: string;
	SuccessCriterion: string;
	Falsifier: string;
	Evidence: string[];
	Cost: "low" | "medium" | "high";
}

export interface Experiment {
	Hypothesis: string;
	Steps: string[];
	Control: string;
	Budget: string;
	ExpectedResult: string;
	Disconfirmation: string;
	StopConditions: string[];
	TechniqueName?: string;
	Observation?: string;
}

const FAILURE = /fail|error|crash|timeout|abort|stuck|circl|regret|leak|invalid|mismatch|stale/i;
const SUCCESS = /pass|verified|fixed|worked|resolved|healthy|succeeded/i;
const COST = /expensive|cost|latency|memory|burn|slow|rate.?limit/i;

function clip(value: unknown, max: number): string {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function top(evidence: Evidence[], pattern: RegExp, limit = 4): string[] {
	return evidence.filter((hit) => pattern.test(hit.Text)).slice(0, limit).map((hit) => clip(hit.Text, 180));
}

export function Predict(focus: string, evidence: Evidence[]): Prediction {
	const failures = top(evidence, FAILURE);
	const successes = top(evidence, SUCCESS);
	const weighted = evidence.reduce((sum, hit) => sum + Math.max(0, hit.Score), 0);
	const baseRate = evidence.length ? successes.length / evidence.length : 0;
	const confidence = clamp(0.25 + Math.log2(1 + evidence.length) * 0.08 + Math.min(0.2, weighted / 200), 0.25, 0.9);
	return {
		Focus: clip(focus, 200),
		Forecast: failures.length > successes.length
			? "Current trajectory is more likely to repeat a known failure path unless a constraint changes."
			: "Current trajectory has enough supporting evidence to continue with bounded steps.",
		Confidence: Math.round(confidence * 100) / 100,
		BaseRate: Math.round(baseRate * 100) / 100,
		EvidenceCount: evidence.length,
		Drivers: [...successes, ...failures].slice(0, 4),
		CounterEvidence: failures.slice(0, 3),
		ExpectedOutcome: failures.length > successes.length ? "A repeated failure or scope expansion." : "Incremental progress if the next step remains small.",
		StopConditions: ["Evidence contradicts the forecast", "Two consecutive failed checks", "Budget or context limit reached"],
	};
}

export function AssessRisk(focus: string, evidence: Evidence[], contextPercent: number | null, toolRepeats: number): RiskAssessment {
	const failures = top(evidence, FAILURE, 6);
	const costs = top(evidence, COST, 4);
	const severity = clamp(1 + failures.length * 0.5 + (contextPercent && contextPercent >= 75 ? 1 : 0), 1, 5);
	const likelihood = clamp(1 + failures.length * 0.4 + toolRepeats * 0.2, 1, 5);
	const risks = [
		...failures.map((risk) => ({ Risk: clip(risk, 180), Severity: 3, Likelihood: 3, Mitigation: "Run the smallest discriminating check before expanding scope." })),
		...costs.map((risk) => ({ Risk: clip(risk, 180), Severity: 4, Likelihood: 2, Mitigation: "Bound time, output, and retries; stop when the metric stops improving." })),
	].slice(0, 5);
	return {
		Focus: clip(focus, 200),
		RiskScore: Math.round(clamp(severity * likelihood * 4, 0, 100)),
		Likelihood: likelihood,
		Impact: severity,
		Risks: risks,
		Recommendation: risks.length ? "Address the top risk with a bounded test before continuing." : "Continue with normal verification; no dominant risk signal in memory.",
		StopConditions: ["Risk score drops below 25", "A higher-priority objective appears", "New contrary evidence arrives"],
	};
}

export function Quantify(focus: string, evidence: Evidence[], contextPercent: number | null, toolRepeats: number): QuantModel {
	const failures = evidence.filter((hit) => FAILURE.test(hit.Text)).length;
	const successes = evidence.filter((hit) => SUCCESS.test(hit.Text)).length;
	return {
		Focus: clip(focus, 200),
		Variables: [
			{ Name: "EvidenceCount", Value: evidence.length, Unit: "items", Source: "PiMnemonicRecall" },
			{ Name: "SuccessSignals", Value: successes, Unit: "items", Source: "text markers" },
			{ Name: "FailureSignals", Value: failures, Unit: "items", Source: "text markers" },
			{ Name: "ContextPercent", Value: contextPercent ?? "unknown", Unit: "%", Source: "ctx.getContextUsage" },
			{ Name: "ToolRepeats", Value: toolRepeats, Unit: "count", Source: "reflect state" },
		],
		Formula: "risk ≈ (FailureSignals + ToolRepeats) / (EvidenceCount + 1), adjusted for context pressure",
		Estimate: `Heuristic risk index ${clamp(((failures + toolRepeats) / (evidence.length + 1)) * 10, 0, 10).toFixed(1)}/10`,
		Uncertainty: evidence.length < 4 ? 0.7 : evidence.length < 10 ? 0.45 : 0.3,
		DataGaps: evidence.length < 4 ? ["Too few recalled items for a stable estimate"] : ["No controlled measurements yet"],
		NextMeasurement: "Run one bounded experiment and record the observed metric.",
	};
}

export function Hypothesize(focus: string, evidence: Evidence[]): Hypothesis {
	const failure = top(evidence, FAILURE, 1)[0] || focus;
	return {
		Claim: `Changing the approach to ${clip(focus, 120)} will reduce the failure pattern: ${clip(failure, 120)}`,
		Null: `The change has no measurable effect on the failure pattern.`,
		Variables: ["approach", "failure_count", "time_to_result", "context_used"],
		Metric: "failure_count per attempt and time_to_result",
		SuccessCriterion: "The failure does not recur in two consecutive bounded attempts.",
		Falsifier: "The same failure recurs after the change, or the metric worsens.",
		Evidence: top(evidence, FAILURE, 3),
		Cost: top(evidence, COST, 1).length ? "high" : "low",
	};
}

export function DesignExperiment(focus: string, hypothesis: string, techniqueName?: string): Experiment {
	return {
		Hypothesis: clip(hypothesis || `Change to ${focus} may improve the outcome.`, 400),
		Steps: [
			"Record the current metric and stop condition.",
			"Change one variable only.",
			"Run one bounded check with capped time and output.",
			"Compare against the recorded baseline and record the result as evidence.",
		],
		Control: "Current approach with no change",
		Budget: "<= 30s runtime, <= 20 KiB output, one variable changed",
		ExpectedResult: "The predicted improvement appears without a new failure signal.",
		Disconfirmation: "No improvement, regression, or repeated failure after the bounded check.",
		StopConditions: ["Timeout", "Output cap", "Two repeated failures", "Objective achieved"],
		...(techniqueName ? { TechniqueName: techniqueName } : {}),
	};
}
