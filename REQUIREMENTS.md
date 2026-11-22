# pi-mnemonic — requirements

Status: v1 requirements, implemented 2026-11-22.

## Goal

Give the Pi agent a durable, bounded working memory that combines:

- **Human-like memory**: generalizable facts learned from experience, recent work episodes, and reusable trajectories.
- **Machine memory**: keyed registers, arrays/hashes with indexed access, hot-cache warming, mustache-style interpolation, named command techniques, and generated reusable tools.

The extension must let the agent start from prior work instead of rediscovering the machine, reuse exact values through templates instead of copying them into prompts, and codify repeated shell work into deterministic scripts/tools.

## Naming convention

The extension/package keeps the required `pi-` prefix. LLM-facing tool names use PascalCase: `PiMnemonic<Action>`, generated technique tools `PiTechnique<Name>`, and tool parameters `Key`, `Value`, `Action`, `Tags`, etc. Slash commands stay lowercase kebab-case (`/pi-mnemonic-help`) per Pi convention. Internal TypeScript helpers stay idiomatic camelCase.

## Non-goals

- No new encrypted vault (engram already owns that role).
- No LLM calls at factory/startup. Structured model calls occur only in cognitive tools/tripwires that can be disabled or opted out; deterministic fallbacks always exist.
- No new credential store (pi-credentials already owns secrets).
- No background processes, sockets, or file watchers.
- No unbounded logs, histories, or caches.

## Prior art reused

- `opencode-vars` (`/home/user/workspace/opencode-templates`): bounded scratchpad, names-only prompt injection, secrets hygiene.
- `engram` (`/home/user/workspace/engram`): episode/fact separation, register ledgers, handle-based recall.
- `handlebars-ai` (`/home/user/workspace/handlebars-ai`): Handlebars-compatible template engine with zero runtime deps.

## Functional requirements

### R1 — Bounded registers

- Store keyed values (`string | number | boolean | null | array | object`) in a JSON file.
- Keys support dot/bracket paths (`project.ports[0]`, `hosts.dev`) for reads and writes.
- Read bumps hit count and recency; writes create/update metadata.
- Caps: 500 registers, 256 KiB total register bytes, 64 KiB per value.
- `list` returns names/metadata without values by default.

### R2 — Human-like facts and episodes

- `learn(claim, tags, confidence, source)` stores deduplicated generalizable facts.
- `note(summary, detail, tags)` records recent work episodes.
- Facts: max 300. Episodes: max 100.
- Both carry timestamps, hit counts, and tags; retrieval is by recency and hit score.

### R3 — Cache warming and context injection

- Track hits on registers, facts, techniques, paths, and commands.
- `warm(keys?)` raises hit scores and returns the compact warm context.
- `before_agent_start` injects a bounded `<pi-mnemonic>` system-prompt section (<= 4 KiB) containing hot registers, recent facts/episodes, reusable techniques, hot paths, and a reminder to call `PiMnemonicGet` / `PiMnemonicRender` for exact values.
- The section is stable so Pi can patch only when it changes.

### R4 — Template interpolation

- `render(template, vars?)` compiles Handlebars with `noEscape: true`.
- Register values are available as template context; explicit `vars` override them.
- Support Handlebars built-ins (`#each`, `lookup`, `if`) plus `count` and `at` helpers.
- Missing references render empty; no exception.

### R5 — Command techniques and deterministic scripts

- A technique has `name`, `command`, `description`, `usage`, optional `params`, `cwd`, and tags.
- Actions: `add`, `get`, `list`, `render`, `delete`, `hit`, `script`, `expose`, `exec`.
- `script` materializes a rendered command as an executable `#!/usr/bin/env bash` file under the extension state dir.
- `exec` runs a rendered technique with a timeout (<= 30 s) and capped output (<= 20 KiB).
- `expose` registers a dynamic tool `PiTechnique<Name>` with one string parameter per declared param. Max 20 dynamic tools.
- Repeated bash commands observed through `tool_call` are recorded automatically after redaction.

### R6 — Environment adaptation

- Record the current working directory as a hot path on each run.
- Record sanitized bash commands observed via `tool_call` (max 200 commands, 500 chars each).
- Redact tokens, passwords, `Bearer`/`Basic` values, and `KEY=value` assignments before storage.
- A stable hot-path/hot-command summary appears in the injected context.

### R7 — Lifecycle and persistence

- State file: `$PI_CODING_AGENT_DIR/pi-mnemonic/store.json` when set, otherwise `$XDG_STATE_HOME/pi-mnemonic/store.json` (or `~/.local/state/pi-mnemonic/store.json`).
- Corrupt store is quarantined as `.corrupt-<timestamp>` and replaced with an empty store.
- Writes are atomic via temp file + rename.
- `session_start` loads state and merges the latest `pi-mnemonic-compact` session entry when the file is empty.
- `session_before_compact` flushes state and appends a bounded compact snapshot entry.
- `session_shutdown` flushes pending writes.
- No resource is started in the extension factory.

### R8 — Self-documentation

- `PiMnemonicHelp` returns tool/command docs, examples, and caps.
- Tool descriptions include action enums and PascalCase parameter names.
- Errors include a `Hint:` line pointing to the right call.
- `/pi-mnemonic-help`, `/pi-mnemonic-status`, and `/pi-mnemonic-warm` mirror the tool surface for humans.

### R9 — Associative recall without embeddings

- `PiMnemonicRecall { Query, Limit? }` searches registers, facts, episodes, and techniques by token overlap, an exact-phrase boost, a 256-dimension hashed token vector cosine score, hit counts, and recency.
- No external embedding model or vector DB: the hashed vector is a deterministic, offline high-dimensional similarity function over bounded collections, cheaper and auditable on this host.
- `before_agent_start` injects a second bounded section, `<pi-mnemonic-recall>`, populated from the current prompt. This reminds the agent of relevant techniques by association.
- Recall results are hints only; exact values still come from `PiMnemonicGet` / `PiMnemonicRender`.

### R10 — Self-codification

- `PiMnemonicCodify { Kind, Name, Summary, Detail?, Command?, Tags?, Params?, Expose? }` turns a discovered technique into durable memory.
- `Kind: Register` stores an exact keyed value; `Technique` stores a reusable command; `Tool` does the same and exposes `PiTechnique<Name>`; `Skill` writes `~/.pi/agent/skills/<slug>/SKILL.md` (or `PI_MNEMONIC_SKILLS_DIR`) with valid frontmatter.
- Every codified item also becomes a fact and an episode so associative recall can find it later.
- The warm context and `PiMnemonicHelp` instruct the agent to codify reusable trajectories instead of letting them disappear into a transcript.

### R11 — Idle session mining

- On `agent_settled`, an idle worker scans past Pi session JSONL files (max 10 most recent, 512 KiB each) when `MemAvailable >= 2 GiB` and cgroup usage `<= 85%`.
- It extracts candidate facts from explicit markers (`Root cause`, `Fix`, `Verified`, `Verdict`, `Conclusion`, `Learned`, `Finding`, `Decision`, `Note`, `Shortcut`, `Hint`) and one episode (first user line) per session.
- Lines beginning `SKILL: slug | summary` are written as lazy-loaded `SKILL.md` files; `CODIFY:` lines become tagged facts.
- Processed session paths are stored in `background.indexed` (last 200) so each session is mined once. The worker yields between sessions, aborts on shutdown signal, and never runs under memory pressure.

### R12 — Markdown variable interpolation

- `AGENTS.md` and other markdown context files are rendered with Handlebars before each run using register values: `{{key}}`, `{{obj.key}}`, `{{arr.0}}`.
- `{{secret:...}}` and `{{credential:...}}` tokens are preserved untouched and left to pi-credentials.
- `PiMnemonicCodify { Kind: 'AgentRule' }` stores a register and appends a `- {{rule.key}} — summary` line to global `AGENTS.md`, so important rules become live interpolated memory.

### R13 — Markdown link warming and weaving

- Markdown links `[label](target)` in context files are parsed with bounded depth (0–3) and 40 links per pass.
- Local files are resolved relative to the document, read up to 8 KiB, summarized from the first heading/paragraph, and cached as `link_*` registers with hints.
- Remote URLs are cached as metadata only (no network fetch in the idle path).
- Circular references are prevented by a visited set; only local `.md` files recurse.
- `PiMnemonicLink { Action: 'Warm' }` warms a markdown file on demand; `Action: 'Weave'` appends a bounded `## Related` section with sibling markdown links.
- A second injected section, `<pi-mnemonic-links>`, lists the top warmed references and hints.

### R14 — Cognitive tools and intelligent structured output

- `PiAssociate { Action: On|Off|Status|Analyze }` is passive by default and can be opted out. Analyze compares the current prompt/response with prior sessions and returns structured `Relevance / WhatWorked / WhatFailed / Trajectory / Outcome / Lesson / ShouldUse`.
- `PiDream { Action: Run|Status|Promote|Config }` namespaces the idle miner. Intelligent runs distill bounded candidate memories into structured `Facts / Skills / Promote` output via `ctx.modelRegistry.complete`, then persist the result.
- `PiPlan { Goal, Steps?, Constraints? }` stores a bounded plan and optionally returns structured `RevisedGoal / Steps / Risks / NextActions` from the current model.
- `PiImagine` and `PiSimulate` generate counterfactual scenarios. They use deterministic rule-based templates as a fallback and, when a model is available, request structured `Scenarios` output. PiSimulate requires falsifiable `Hypothesis`, bounded `Experiment`, and `Success` criteria.
- All intelligent calls are opt-out per call (`Intelligent: false`), bounded to <= 1000 output tokens, and fall back to deterministic output on failure. Structured results are also returned as `structuredContent` for programmatic callers.

### R15 — Conditional metacognition

- `PiReflect` and its alias `PiObserve` fire on boolean triggers: configurable phrase regexes, every-N-turns, turns-since-last-reflection, context-percent threshold, repeated tool use, manual slash command `/pi-mnemonic-reflect`, or an explicit agent call.
- Reflection requests structured JSON with `Verdict (Continue|Scope|Reset|Plan|Exit)`, `Useful`, `Rational`, `Aligned`, `Novelty`, `Risks`, `Guidance`, `NextAction`, `InjectedPrompt`, `StopConditions`, `Evidence`, and `Confidence`.
- `InjectedPrompt` is the exact next-turn steering prompt. It is stored as `reflect.pending` and injected as `<pi-mnemonic-reflect>` on the next `before_agent_start`, then consumed.
- Deterministic fallback covers phrase/risk heuristics (circling, privacy/credential exposure, context pressure) when no model is available or `Intelligent: false`.
- Config registers: `reflect.enabled`, `reflect.everyNTurns` (default 12), `reflect.contextPercent` (default 75), `reflect.toolRepeatThreshold` (default 5), `reflect.cooldownTurns` (default 6), `reflect.patterns`.

### R16 — Quantitative meta-cognition

- `PiPredict` forecasts the current trajectory from recalled evidence with confidence, base rate, drivers, counter-evidence, and stop conditions.
- `PiRiskAssessment` / `PiAssessment` produce a bounded quantitative risk register (likelihood, impact, score, mitigations).
- `PiQuantify` / `PiModel` turn evidence into a simple model with observed variables, formula, estimate, uncertainty, and next measurement. It does not invent unmeasured values.
- `PiHypothesis` converts an assumption into a falsifiable claim with null, metric, success criterion, and falsifier.
- `PiExperiment` designs a bounded experiment and can run it through a registered `PiTechnique` with the existing timeout/output caps, recording observations as evidence.
- All five tools are manually callable and optionally use `ctx.modelRegistry.complete` for structured output; deterministic grounded fallbacks always exist.
- Conditional tripwire: setting `meta.auto=true` injects a deterministic quantitative risk note when context usage >= 80% or a tool repeats >= 5 times.

### Credentials stance

- This extension does not try to detect PII. Secrets and personal data must be handled by reference through `pi-credentials`; the provider, model, and session log should see tokens, not values.
- The redaction in `src/redact.ts` is defense-in-depth for command text only, not a promise of PII discovery. `credential_*` owns secret storage and interpolation.

### R17 — Editable prompt cards

- Every structured-output system prompt is keyed by a PascalCase name (`PiReflect`, `PiPredict`, etc.).
- Defaults live as constants in `src/prompt-defaults.ts` and are used when a card is missing or invalid.
- Editable cards live in `.config/prompts/<Key>.yaml` inside the extension folder in the simple format `key: <Key>` plus `prompt: |` with an indented block.
- `src/prompt-cards.ts` loads at most 32 YAML cards, caches by aggregate mtime, and never watches files.
- `PiPrompt { Action: List|Get|Set|Reset }` lists keys/sources, reads the effective prompt, writes a card, or restores the default.

### R18 — Cold storage and unified tripwires

- `PiPrune { Action: Preview|Run|Restore|Status|Config }` moves stale, unused, or noisy registers, facts, episodes, techniques, paths, and commands into a separate bounded cold file (`store.cold.json`).
- Protected prefixes (`rule.`, `associate.`, `reflect.`, `meta.`, `background.`, `dream.`, `prune.`, `plan_`) and pinned items are never auto-pruned.
- Cold storage caps: 200 items / 1 MiB; `Restore Key` returns an item to active memory.
- Tripwire conditions are implemented once in `src/tripwire.ts` and shared by reflection, quantitative auto context, and pruning: regex patterns, keyword hits, turn counts, context percent, repeated tools, manual calls, code predicates, and typed boolean/enum decision models.
- Prompt cards `PiTriggerDecision` and `PiPruneDecision` provide editable JSON specs for typed decisions; invalid or absent responses fall back to deterministic evaluation.
- `prune.auto=true` enables deterministic automatic pruning on trigger; the agent and operator can always invoke `PiPrune` manually.

### R19 — Operating charter

- Default charter text is a non-binding ethics reminder citing UN/UDHR/IHL source documents; Asimov's Three Laws are a mnemonic only. It is not legal advice.
- A bounded source index with authoritative URLs lives in `.config/charter/SOURCES.md`; full documents are not copied into context.
- `PiCharter { Action: Show|Config|Enable|Disable|Source }` modes: `trigger` (default), `always`, `periodic`, `off`. Periodic uses `charter.everyNTurns`; default trigger patterns match sanctions/export-control keywords in the prompt (including incidental mentions); this is prompt guidance, not a compliance determination. International-law content is not injected for ordinary engineering or generic "stuck" prompts.
- The charter is injected as `<pi-mnemonic-charter>` and is operator-editable like other prompt cards.

### R20 — Pinning and cold promotion

- Markdown token syntax `{{key!important}}`, `{{key#alwayson}}`, and `{{key//remember}}` pins an existing register/fact/episode/technique/path/command to the current project scope and then renders normally.
- Pinned items are skipped by `PruneCandidates` and `Prune` and never move to cold storage.
- `Store.Pin/Unpin` support scoped pins (`pinnedScopes`).
- Repeated PiAssociate signals increment `Signal` on matching cold items; at `associate.promoteThreshold` (default 5) the item is restored to active memory and reported in the association section.

### R21 — Opt-in observability

- Usage telemetry is disabled by default. `PiStats Enable`/`Disable` and `/pi-mnemonic-stats enable|disable` require operator confirmation.
- While enabled, bounded rows record tool/action, timestamp, duration, success/error, input/output byte counts, model id, trigger labels, and section sizes. Raw prompts, values, and command text are not persisted by telemetry.
- `PiStats Dump` aggregates by tool/action/model/trigger with calls, success/error, avg/p95 duration, and byte totals.
- `PiStats Export` supports `json`, `jsonl`, `eval`, `langsmith`, `langfuse`, and `otel` shapes; file exports require confirmation and write 0600.
- `PiStats Query` filters by `SinceMs`; `Reset` clears the bounded 2,000-row history.
- Built-in tool outcomes are observed via `tool_execution_end`; PiMnemonic tool calls are wrapped automatically.

### R22 — Cross-platform installation

- `scripts/pi-mnemonic-install.mjs` wraps `pi install` / `pi remove` using Node's `spawnSync`, avoiding shell quoting differences.
- POSIX and PowerShell wrappers provide `install.sh`, `uninstall.sh`, `install.ps1`, `uninstall.ps1`.
- Supports git (default), npm, local checkout, explicit source, project-local settings, dry-run, and uninstall of all known sources.
- Installers change only Pi settings via the Pi CLI; they do not edit settings files directly.

## Safety and bounds

- All collections have explicit caps in `store.ts` and are pruned before save.
- Technique names match `[a-z0-9_-]+`; generated tool names are PascalCase with hyphens/underscores normalized.
- Dynamic tool count capped at 20.
- Shell execution only from stored techniques, with timeout and output caps.
- No secret values are stored by the automatic bash recorder; explicit register writes are the agent's responsibility, and `pi_mnemonic_help` warns against storing secrets (use `credential_*`).

## Acceptance criteria

1. `node --experimental-strip-types --test tests/*.test.ts` passes for store and template modules.
2. Store caps hold after 10k writes in a bounded stress check.
3. Template renders nested paths, `#each`, `lookup`, `count`, and `at`.
4. Extension loads with `pi -e index.ts` and registers `PiMnemonic*` tools plus `/pi-mnemonic-*` commands.
5. A technique can be added, rendered, materialized as a script, exposed as `PiTechnique<Name>`, and executed with capped output.
6. `before_agent_start` injects a stable, capped `<pi-mnemonic>` section.
7. No file watcher, timer, subprocess, or socket is started at factory time.
