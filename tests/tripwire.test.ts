import { test } from "node:test";
import assert from "node:assert/strict";
import { EvaluateTriggers, KeywordHits, SafePatternHits } from "../src/tripwire.ts";

test("SafePatternHits ignores pathological regexes", () => {
	const hits = SafePatternHits("stuck in a loop", ["stuck", "(a+)+$", "loop"]);
	assert.deepEqual(hits, ["Pattern stuck", "Pattern loop"]);
});

test("KeywordHits matches lowercase keywords", () => {
	assert.deepEqual(KeywordHits("Too much NOISE here", ["noise", "stale"]), ["noise"]);
});

test("EvaluateTriggers supports manual, code, and typed decision", () => {
	assert.equal(EvaluateTriggers({ Focus: "x", Manual: true }).Triggered, true);
	assert.equal(EvaluateTriggers({ Focus: "x", CodeCondition: true }).Triggered, true);
	assert.equal(EvaluateTriggers({ Focus: "x", Decision: "Fire" }).Triggered, true);
	assert.equal(EvaluateTriggers({ Focus: "x", Decision: "Skip", Manual: true }).Triggered, false);
	assert.equal(EvaluateTriggers({ Focus: "x", ContextPercent: 90, ContextThreshold: 85, CooldownTurns: 6, TurnsSince: 1 }).Triggered, true);
	assert.equal(EvaluateTriggers({ Focus: "x", ContextPercent: 90, ContextThreshold: 85 }).Triggered, true);
});
