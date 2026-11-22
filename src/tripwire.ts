export interface TriggerResult {
	Triggered: boolean;
	Reasons: string[];
	Focus: string;
	Decision?: "Fire" | "Skip" | "Defer" | boolean;
}

export const DEFAULT_CHARTER_PATTERNS = [
	"sanctioned (?:individual|person|entity|organization|organisation|party|program|programme)",
	"\\bOFAC\\b|SDN list|specially designated (?:national|person|entity)",
	"(?:UN|EU|UK|US) sanctions|sanctions (?:screening|compliance|evasion|violation)",
	"\\bembargo\\b|export controls?|\\bITAR\\b|denied party|blocked person|restricted party",
];

export const DEFAULT_PRUNE_PATTERNS = [
	"prune|cold storage|noise|stuffing|too much context|irrelevant|stale",
	"clean up|compact memory|unused|not being used",
];

export const DEFAULT_TRIGGER_PATTERNS = [
	"run aground|going in circles|stuck|spinning|yakshav|waste of time|not useful|why are we|what are we doing",
	"reset|compact|start over|step back|sanity check|reflect|regret",
	"prune|cold storage|noise|stuffing|too much context|irrelevant",
];

export function KeywordHits(text: string, keywords: string[]): string[] {
	const lower = String(text || "").toLowerCase();
	return keywords.filter((word) => word.length >= 3 && lower.includes(word.toLowerCase())).slice(0, 12);
}

export function SafePatternHits(text: string, patterns: string[]): string[] {
	const reasons: string[] = [];
	const sample = String(text || "").slice(0, 2000);
	for (const pattern of patterns.slice(0, 16)) {
		const risky = /\([^)]*[+*][^)]*\)[+*]/.test(pattern) || /\([^)]*\|[^)]*\)[+*{]/.test(pattern) || /\{1,\d*\}\s*[+*]/.test(pattern);
		if (pattern.length > 200 || risky) continue;
		try {
			if (new RegExp(pattern, "i").test(sample)) reasons.push(`Pattern ${pattern}`);
		} catch {
			// Invalid regexes are ignored by design.
		}
	}
	return reasons;
}

export function EvaluateTriggers(input: {
	Focus: string;
	LastResponse?: string;
	Patterns?: string[];
	Keywords?: string[];
	EveryNTurns?: number;
	Turns?: number;
	TurnsSince?: number;
	ContextPercent?: number | null;
	ContextThreshold?: number;
	ToolRepeats?: number;
	ToolRepeatThreshold?: number;
	CooldownTurns?: number;
	Manual?: boolean;
	CodeCondition?: boolean;
	Decision?: "Fire" | "Skip" | "Defer" | boolean;
}): TriggerResult {
	const text = `${input.Focus}\n${input.LastResponse || ""}`;
	const reasons = [
		...SafePatternHits(text, input.Patterns || []),
		...KeywordHits(text, input.Keywords || []).map((word) => `Keyword ${word}`),
	];
	if (input.Manual) reasons.push("Manual request");
	if (input.CodeCondition) reasons.push("Code condition true");
	if (input.Decision === true || input.Decision === "Fire") reasons.push("Decision model Fire");
	if (input.EveryNTurns && input.Turns && input.Turns % input.EveryNTurns === 0) reasons.push(`${input.Turns} turns elapsed`);
	if (input.TurnsSince !== undefined && input.EveryNTurns && input.TurnsSince >= input.EveryNTurns) reasons.push(`${input.TurnsSince} turns since last run`);
	if (input.ContextPercent !== null && input.ContextPercent !== undefined && input.ContextThreshold && input.ContextPercent >= input.ContextThreshold) {
		reasons.push(`Context ${Math.round(input.ContextPercent)}% >= ${input.ContextThreshold}%`);
	}
	if (input.ToolRepeats !== undefined && input.ToolRepeatThreshold && input.ToolRepeats >= input.ToolRepeatThreshold) {
		reasons.push(`Tool repeated ${input.ToolRepeats} times`);
	}
	const veto = input.Decision === false || input.Decision === "Skip" || input.Decision === "Defer";
	const urgent = reasons.some((reason) => /Pattern |Context |repeated/i.test(reason));
	const cooldown = input.TurnsSince !== undefined && input.CooldownTurns && input.TurnsSince < input.CooldownTurns;
	const Triggered = !veto && reasons.length > 0 && (Boolean(input.Manual) || Boolean(input.CodeCondition) || input.Decision === true || input.Decision === "Fire" || urgent || !cooldown);
	return { Triggered, Reasons: reasons, Focus: input.Focus, Decision: input.Decision };
}
