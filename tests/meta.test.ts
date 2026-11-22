import { test } from "node:test";
import assert from "node:assert/strict";
import { AssessRisk, DesignExperiment, Hypothesize, Predict, Quantify, type Evidence } from "../src/meta.ts";

const evidence: Evidence[] = [
	{ Kind: "Fact", Key: "f1", Text: "Xvfb test hit a timeout after five retries", Score: 4 },
	{ Kind: "Fact", Key: "f2", Text: "Rebuilding the stale library fixed the segfault", Score: 3 },
];

test("Predict uses failure evidence and reports bounded confidence", () => {
	const result = Predict("xvfb timeout", evidence);
	assert.ok(result.Forecast.length > 0);
	assert.ok(result.Confidence >= 0.25 && result.Confidence <= 0.9);
	assert.equal(result.EvidenceCount, 2);
});

test("AssessRisk produces bounded scores and mitigations", () => {
	const result = AssessRisk("xvfb timeout", evidence, 82, 6);
	assert.ok(result.RiskScore >= 0 && result.RiskScore <= 100);
	assert.ok(result.Risks.length > 0);
	assert.ok(result.Risks[0].Mitigation.length > 0);
});

test("Quantify exposes observed variables and uncertainty", () => {
	const result = Quantify("xvfb timeout", evidence, 82, 6);
	assert.ok(result.Variables.some((v) => v.Name === "EvidenceCount"));
	assert.ok(result.Uncertainty >= 0 && result.Uncertainty <= 1);
});

test("Hypothesis and experiment are falsifiable", () => {
	const hypothesis = Hypothesize("xvfb timeout", evidence);
	assert.ok(hypothesis.Null.length > 0);
	assert.ok(hypothesis.Falsifier.length > 0);
	const experiment = DesignExperiment("xvfb timeout", hypothesis.Claim, "safe-xvfb");
	assert.equal(experiment.TechniqueName, "safe-xvfb");
	assert.ok(experiment.StopConditions.length > 0);
});
