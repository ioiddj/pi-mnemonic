# pi-mnemonic

Bounded working memory for Pi: registers, facts, recent work, reusable techniques, template interpolation, and generated tools. See [REQUIREMENTS.md](./REQUIREMENTS.md) for the full contract.

## Install

```sh
pi install git:github.com/ioiddj/pi-mnemonic
```

Once published to npm:

```sh
pi install npm:@ioiddj/pi-mnemonic
```

## Load

Auto-discovered from `~/.pi/agent/extensions/pi-mnemonic/index.ts`. Manual reflection: `/pi-mnemonic-reflect [focus]`. Automatic triggers include matching phrases, every 12 turns, high context usage, repeated tools, and manual/agent calls.

Use `/reload` after edits, or smoke-load with:

```sh
pi -e ~/.pi/agent/extensions/pi-mnemonic/index.ts
```

## Tools (PascalCase)

- `PiMnemonicHelp` — API, examples, caps.
- `PiMnemonicSet { Key, Value, Tags? }` — store a register; `Key` supports `hosts.dev[0]`.
- `PiMnemonicGet { Key, Template?, Vars? }` — recall exact value, optionally through Handlebars.
- `PiMnemonicList { Prefix?, IncludeValues? }` — metadata first, values opt-in.
- `PiMnemonicDelete { Key }` — remove a register/path.
- `PiMnemonicLearn { Claim, Tags?, Confidence?, Source? }` — generalizable fact.
- `PiMnemonicNote { Summary, Detail?, Tags? }` — recent work episode.
- `PiMnemonicRender { Template, Vars? }` — interpolate without copying exact data.
- `PiTechnique { Action, Name?, ... }` — Add/Get/List/Render/Delete/Hit/Script/Expose/Exec.
- `PiMnemonicWarm { Keys? }` — raise hotness and return warm context.
- `PiMnemonicRecall { Query, Limit? }` — associative recall of prior techniques by token overlap, hits, and recency (no vector DB).
- `PiMnemonicCodify { Kind, Name, Summary, Detail?, Command?, Tags?, Params?, Expose? }` — self-codify as `Register`, `Technique`, `Tool`, `Skill`, or `AgentRule` (appends an interpolated token to global AGENTS.md).
- `PiMnemonicLink { Action, Path, Depth?, MaxLinks? }` — `Warm` caches markdown link hints; `Weave` appends a bounded `## Related` section to the target `.md` file.
- `PiAssociate { Action: On|Off|Status|Analyze, Query?, Intelligent? }` — passive session association; Analyze returns structured what-worked/failed/trajectory/outcome/lesson.
- `PiDream { Action: Run|Status|Promote|Config, Intelligent?, Promote? }` — namespaces the idle miner and can distill structured facts/skills/promotions.
- `PiPlan { Goal, Steps?, Constraints?, Intelligent? }` — stores a plan and optionally returns a structured critique.
- `PiImagine { Focus?, Limit?, Intelligent? }` — speculative counterfactuals.
- `PiSimulate { Focus?, Limit?, Intelligent? }` — rigorous counterfactuals with Hypothesis/Experiment/Success.
- `PiReflect` / `PiObserve { Action: Run|Status|Config|Enable|Disable, Focus?, Intelligent? }` — structured step-back check with `InjectedPrompt` steering the next turn.
- `PiPredict` — evidence-grounded forecast.
- `PiRiskAssessment` / `PiAssessment` — quantitative risk register.
- `PiQuantify` / `PiModel` — bounded variable model with uncertainty.
- `PiHypothesis` — falsifiable hypothesis from an assumption.
- `PiExperiment` — bounded experiment design, optionally run via a `PiTechnique`.
- `PiPrompt { Action: List|Get|Set|Reset, Key?, Prompt? }` — manage editable YAML prompt cards.
- `PiPrune { Action: Preview|Run|Restore|Status|Config }` — move stale/noisy memory into bounded cold storage, restore it, or configure triggers.
- `PiCharter { Action: Show|Config|Enable|Disable|Source }` — operating charter with source links; default mode `trigger` fires on sanctions/export-control keywords in the prompt (including incidental mentions); it is prompt guidance, not a compliance determination. `always`, `periodic`, `off` also available.
- `PiStats { Action: Dump|Enable|Disable|Export|Query|Reset, Format?, Path?, Limit?, SinceMs? }` — opt-in usage telemetry and exports.
- `PiMnemonicStats {}` — counts and caps.

`Expose` creates `PiTechnique<Name>` tools with one string parameter per declared `Params` entry. Generated commands are capped at 30 s and 20 KiB output.

## Commands (lowercase kebab-case)

- `/pi-mnemonic-help`
- `/pi-mnemonic-status`
- `/pi-mnemonic-warm Key,Key`
- `/pi-mnemonic-reflect [focus]`
- `/pi-mnemonic-associate on|off|status`
- `/pi-mnemonic-stats [json|jsonl|eval|langsmith|langfuse|otel] [path]`

## Observability

Usage telemetry is **off by default**. Enable with `PiStats Enable` or `/pi-mnemonic-stats enable` (operator confirmation required). While enabled, the extension records bounded metadata only: tool/action, timestamp, duration, success/error, input/output byte counts, model id, trigger labels, and section sizes. It does not persist raw prompts, values, or command text.

`PiStats Dump` shows aggregates; `Export` writes JSON/JSONL/eval/LangSmith/Langfuse/OTel-shaped rows to the session or a file. `Reset` clears bounded history. Exports and enable/disable operations require confirmation.

## Charter and pinning

The charter is a non-binding ethics reminder citing UN/UDHR/IHL documents; Asimov's laws are a mnemonic only. It is not legal advice. Source links: `.config/charter/SOURCES.md`; use `PiCharter Source` to print the path.

Pin important memory from markdown with `{{key!important}}`, `{{key#alwayson}}`, or `{{key//remember}}`. Pinned items are skipped by pruning. Repeated associate signals promote cold items back into active memory.

## Editable prompts

System prompts for the meta tools live in `.config/prompts/<Key>.yaml`:

```yaml
key: PiReflect
prompt: |
  You are a metacognitive reviewer. ...
```

Defaults remain in `src/prompt-defaults.ts`; missing or invalid cards fall back to those constants. Use `PiPrompt` to list, read, write, or reset a card. No file watcher is started.

## Storage

State lives at `$PI_CODING_AGENT_DIR/pi-mnemonic/store.json` or `$XDG_STATE_HOME/pi-mnemonic/store.json`. Writes are atomic; corrupt files are quarantined. Automatic bash recording applies best-effort redaction of common token/password patterns; do not run commands containing secrets.

When you discover a reusable trajectory or capability, call `PiMnemonicCodify` so future sessions are reminded of it by association. Prefer `Tool` for deterministic commands, `Skill` for multi-step knowledge, and `AgentRule` for globally important rules.

`AGENTS.md` and other markdown context files support `{{register}}` interpolation; `{{secret:...}}` tokens are preserved. Markdown links are warmed into cached hints (local files get a brief summary; remote URLs are metadata only). PiDream mines past sessions for facts and `SKILL:` lines when memory headroom is available; PiAssociate injects passive session associations. Recall uses a deterministic 256-dimension hashed-token cosine similarity; intelligence-heavy tools use `ctx.modelRegistry.complete` for structured output when a model is available, with deterministic fallbacks.

Tripwire conditions are shared across tools (`src/tripwire.ts`): regex, keyword, turn count, context percent, repeated tools, manual/code predicates, and typed boolean/enum decision models. Set `prune.auto=true` to enable deterministic automatic pruning.

Secrets and PII should be handled by reference only through `pi-credentials`. This extension does not attempt PII detection; redaction is defense-in-depth for command text, not a guarantee. Use `credential_set` and `{{secret:NAME}}` for credentials.

## Development

```sh
npm run check   # tsc --noEmit + node:test (37 tests)
npm run smoke   # pi -p -e ./index.ts "Reply with OK only"
```

Handlebars is vendored under `vendor/handlebars-ai/`; host-provided Pi imports are linked per-package under `node_modules/@earendil-works/` for standalone tests. Do not symlink the whole `@earendil-works` directory: `npm install` can follow it and prune the Pi installation.

Operator-only changes (`PiCharter Enable/Disable/Config`, `PiPrompt Set/Reset`, `PiMnemonicCodify AgentRule/Skill`, markdown `Weave`, enabling `dream.autoPromote`) require interactive `ctx.ui.confirm` approval.
