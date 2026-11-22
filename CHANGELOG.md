# Changelog

## [0.2.0] - 2026-11-22

- Added opt-in `PiStats` observability and `/pi-mnemonic-stats` command.
- Bounded usage rows with aggregate stats and exports to JSON, JSONL, eval, LangSmith, Langfuse, and OTel shapes.
- Automatic instrumentation of PiMnemonic tools, context sections, and built-in tool outcomes.

## [0.1.0] - 2026-11-22

Initial public release.

- Bounded keyed registers, facts, episodes, recent work, and hot-path/command tracking.
- Editable YAML prompt cards with built-in defaults.
- Handlebars interpolation via vendored `handlebars-ai`; secret macros are preserved.
- Markdown link warming and bounded `Related` weaving.
- Associative recall using token overlap, hashed-token cosine similarity, hits, and recency.
- Metacognition tools: reflect/observe, predict, risk assessment, quantify/model, hypothesis, experiment, imagine/simulate, plan.
- Idle session mining (`PiDream`) with optional structured distillation and opt-in global promotion.
- Cold storage with pinning, repeated-association promotion, and bounded pruning.
- Conditional operating charter with source index and sanctions-triggered default.
- Hardening: path guards, byte caps, redaction of tool output, operator confirmation for global writes, and strict TypeScript checking.
