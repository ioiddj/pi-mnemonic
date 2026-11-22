# Changelog

## [0.5.0] - 2026-11-22

- Added `/pi-mnemonic-dream` control dialog with opt-in enable, idle time, depth, sweep, and prompt-card editing.
- Idle miner is now off by default and reads depth/sweep/idle settings from registers.

## [0.4.1] - 2026-11-22

- Polish pass: deterministic fallback fixes for pruning/model calls, telemetry de-duplication, repeat counters, idle miner session detection, Dream confirmations, generated-tool reconciliation, cross-platform technique execution, safe exports, hardened link resolution, real Pi keybinding IDs, and corrected installer npm source.

## [0.4.0] - 2026-11-22

- Added `/pi-mnemonic-registers` themed TUI overlay for local memory inspection.
- Added engram conflict detection and `PiMemoryCompat` / `/pi-mnemonic-compat` coexistence modes.
- Vendored Pi 1.6.0 TUI docs, UI references, examples, and a local `pi-tui` SKILL.md.

## [0.3.0] - 2026-11-22

- Added cross-platform install/uninstall scripts (`install.sh`, `uninstall.sh`, `install.ps1`, `uninstall.ps1`, Node installer).
- Added npm scripts for git/npm/local install and uninstall.

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
