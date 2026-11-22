# pi-mnemonic

Bounded working memory for Pi: registers, facts, recent work, reusable techniques, template interpolation, and generated tools. See [REQUIREMENTS.md](./REQUIREMENTS.md) for the full contract.

## Install

Requires Node >=22.19.0 and `pi` on PATH. Cross-platform installers are included:

```sh
# POSIX (macOS/Linux/WSL)
./install.sh

# Windows PowerShell
.\install.ps1

# Node, any platform
node scripts/pi-mnemonic-install.mjs
```

Direct Pi commands:

```sh
pi install git:github.com/ioiddj/pi-mnemonic
# once published to npm
pi install npm:@ioiddj/pi-mnemonic
```

Options: `--git` (default), `--npm`, `--local`, `--source <spec>`, `--project`/`-l`, `--dry-run`.

Uninstall:

```sh
./uninstall.sh
.\uninstall.ps1
node scripts/pi-mnemonic-install.mjs --uninstall
```

Uninstall removes the git, npm, and local sources by default. Use `--npm` or `--local` to remove only one source.

## Load

Installed packages load through the `pi.extensions` manifest. A direct checkout is also auto-discovered from `~/.pi/agent/extensions/pi-mnemonic/index.ts`. Manual reflection: `/pi-mnemonic-reflect [focus]`. Automatic triggers include matching phrases, every 12 turns, high context usage, repeated tools, and manual/agent calls.

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
- `PiDream { Action: Run|Status|Promote|Config, Intelligent?, Promote?, Skill? }` — idle miner; Run distills facts/skills by default, while global promotion requires explicit approval.
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
- `PiCharter { Action: Show|Config|Enable|Disable|Source }` — operating charter with source links. Default mode is `trigger`: regex/keywords prefilter the prompt, then an optional structured decision can veto. `Enable` without a Mode sets `always`; use `Config { Mode: "trigger" }` for trigger mode. Not a compliance determination.
- `PiStats { Action: Dump|Enable|Disable|Export|Query|Reset, Format?, Path?, Limit?, SinceMs? }` — opt-in usage telemetry and exports.
- `PiMemoryCompat { Action: Status|Set, Mode? }` — manage engram coexistence mode.
- `PiMnemonicStats {}` — counts and caps.

`Expose` creates `PiTechnique<Name>` tools with one string parameter per declared `Params` entry. Generated commands are capped at 30 s and 20 KiB output.

## Commands (lowercase kebab-case)

- `/pi-mnemonic-help`
- `/pi-mnemonic-status`
- `/pi-mnemonic-warm Key,Key`
- `/pi-mnemonic-reflect [focus]`
- `/pi-mnemonic-associate on|off|status`
- `/pi-mnemonic-stats [json|jsonl|eval|langsmith|langfuse|otel] [path]`
- `/pi-mnemonic-registers`
- `/pi-mnemonic-dream`
- `/pi-mnemonic-compat [coexist|mnemonic-primary|engram-primary|off]`

## Register visualization and engram compatibility

`/pi-mnemonic-registers` opens a themed terminal overlay with views for registers, facts, episodes, techniques, cold storage, and usage. Use `1`-`6` to switch views, arrow/page keys to scroll, `r` to refresh, and `Esc`/`Ctrl+C` to close.

When engram is also installed, pi-mnemonic detects it and reports the overlap. Modes: `coexist` (default), `mnemonic-primary`, `engram-primary`, `off`. In `engram-primary` or `off`, pi-mnemonic suppresses its context injections and idle mining. Changing mode requires operator confirmation.

## Idle miner control

`/pi-mnemonic-dream` opens a centered dialog for the idle miner. Defaults: disabled, idle time 15s, depth 10 sessions, sweep 512KB per session. Controls: `Space` toggle opt-in, `-`/`+` idle time, `[`/`]` depth, `{`/`}` sweep, `j`/`k` or arrows choose a prompt card, `e` edit the selected card, `Enter` save, `Esc` cancel. Changes require operator confirmation.

Editable miner prompts: `PiDream`, `PiTriggerDecision`, and `PiPruneDecision`. They live in `.config/prompts/` and fall back to built-in constants.

## Markdown memory index

Keep AGENTS.md and other context files sparse: store detailed notes in registers and link to canonical paths. `{{key}}` interpolates a register value on each turn; the hint helper inlines the cached value itself up to 1200 characters so the agent gets the answer without spending a tool call. Only truncated values add `PiMnemonicGet Key=key` for the exact remainder; a missing key lists nearby available keys instead of forcing `PiMnemonicList`. `{{secret:NAME}}` is preserved verbatim and is never interpolated.

Markdown links may point to local files, directories, canonical source/readonly docs, or `http(s)` URLs. `Warm` stores a bounded summary in `link_*` registers and surfaces up to eight as `<pi-mnemonic-links>`. Local targets are confined to the current project and the Pi agent directory; binary and oversized files get a path-only hint.

## Scoped and associative access (default)

Memory is scoped by default; global recall is the fallback, not the starting point.

- `PiMnemonicSet`, `PiMnemonicLearn`, `PiMnemonicNote` and `PiMnemonicCodify` automatically add `project:<slug>` plus the bare `<slug>` from the tool context cwd. Add `concept:<x>`, `task:<x>` or `kind:<x>` tags yourself for cross-project categories; tags are deduplicated and capped.
- The associative sections injected before each turn (`pi-mnemonic-recall`, `pi-mnemonic-associate`) first try the current project tag plus concept tags salient in the prompt, then project-only, then concept-only, and only then plain global recall. The rendered section names the scope it used. Overlapping text is boosted, so salience still wins inside a scope.
- `PiMnemonicRecall { Query, Limit?, Tags?, Project?, Concept?, Cwd?, Mode? }` exposes the same behavior to the agent. `Project` is shorthand for a `project:` tag; `Concept` for a `concept:` tag; `Cwd` derives a project tag from another path; `Tags` accepts any category. `Mode:"all"` (default) requires every tag, `Mode:"any"` broadens the query. Tag-only hits are returned, so asking for a project recalls all knowledge tagged for it.

```json
{ "Query": "quality gates", "Project": "pi-fleet" }
{ "Query": "unboxed dialogs", "Tags": ["concept:v0", "task:review"], "Mode": "any" }
{ "Query": "scratch ports", "Cwd": "/home/user/projects/twisted-xng" }
```

If guidance would normally be injected only under a project cwd, or fired only for a salient task the way conditional cursor rules do, store it as a tagged fact/episode/register and recall it by project/task/concept instead of growing AGENTS.md. The agent remains free to query globally by omitting filters; the default is simply scoped and associative first.

## Fleet runs

When `pi-fleet` is installed, each `fleet_delegate` run emits a bounded `pi-fleet:run` event. PiMnemonic mines child `CODIFY:` / `Root cause:` / `Fix:` lines into deduplicated facts tagged `fleet-mined`, plus one episode summarizing the run. The payload is already bounded by pi-fleet (12 children, 8KB output and 1KB error each) and this extension caps extraction at 12 facts per child. No child needs the mnemonic extension: child sessions have extensions disabled.

Disable fleet mining with `PiMnemonicSet Key=fleet.mine Value=false`; `fleet.lastRun` records the most recent trace and fact count.

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

State lives at `$PI_CODING_AGENT_DIR/pi-mnemonic/store.json` or `$XDG_STATE_HOME/pi-mnemonic/store.json`. Every flush takes a bounded cross-process lock (`<file>.lock`, 3s timeout, 30s stale reclamation), re-reads disk, and merges newer changes per item — including individual nested register fields — before replacing the file via temp + rename. Deletes are sticky per field. A scalar root written whole by two agents still resolves newest-write-wins. Locking is cooperative; an outside writer is detected by inode/size/mtime fingerprint and the merge retries up to three times before failing rather than silently overwriting. Cold storage, related-link weaving, SKILL.md updates, AGENTS.md rule appends and exports use the same helpers. Do not hand-edit `store.json` while agents are running; use the tools. Corrupt files are quarantined. Automatic bash recording applies best-effort redaction of common token/password patterns; do not run commands containing secrets.

When you discover a reusable trajectory or capability, call `PiMnemonicCodify` so future sessions are reminded of it by association. Prefer `Tool` for deterministic commands, `Skill` for multi-step knowledge, and `AgentRule` for globally important rules.

`AGENTS.md` and other markdown context files support `{{register}}` interpolation; `{{secret:...}}` tokens are preserved. Markdown links are warmed into cached hints (local files get a brief summary; remote URLs are metadata only). PiDream mines past sessions for facts and `SKILL:` lines when memory headroom is available; PiAssociate injects passive session associations. Recall uses a deterministic 256-dimension hashed-token cosine similarity; intelligence-heavy tools use `ctx.modelRegistry.complete` for structured output when a model is available, with deterministic fallbacks.

Tripwire conditions are shared across tools (`src/tripwire.ts`): regex, keyword, turn count, context percent, repeated tools, manual/code predicates, and typed boolean/enum decision models. Set `prune.auto=true` to enable deterministic automatic pruning.

Attack hardening: reserved path segments are rejected even inside quoted keys, deletes use bounded tombstones, malformed markdown templates cannot fail a turn, remote URL credentials are redacted before caching, and operator confirmation covers all persistent global writes. Writes refuse symlinks and hardlinked targets and detect outside writers by content fingerprint. Simultaneous writes to the same value are not silently lost: the newer value wins and both are recorded in a bounded conflict list exposed by `PiMnemonicStats`. Advisory locks still cannot force external writers that ignore them.

Secrets and PII should be handled by reference only through `pi-credentials`. This extension does not attempt PII detection; redaction is defense-in-depth for command text, not a guarantee. Use `credential_set` and `{{secret:NAME}}` for credentials.

## Pi TUI development docs

This package vendors Pi 1.6.0 TUI documentation and UI references under `docs/pi/` and a local skill at `skills/pi-tui/SKILL.md`. Use the skill when adding or reviewing overlays, dialogs, widgets, key handling, or theming. The register browser follows those contracts: Pi theme tokens, Pi keybindings, `truncateToWidth`/`visibleWidth`, and centered `overlayOptions`.

## Development

```sh
npm run check            # tsc --noEmit + oxlint --deny-warnings + node:test
npm run lint             # oxlint on index.ts, src, tests, scripts
npm run typecheck        # strict tsc with unused/override/fallthrough checks
npm run typecheck:indexed # known-debt gate: adds noUncheckedIndexedAccess
npm run smoke            # pi -p -e ./index.ts "Reply with OK only"
```

Oxlint is a fast native linter with zero configuration here; `--deny-warnings` keeps the gate strict. `typecheck:indexed` is an explicit debt tracker for remaining array/index access sites and is not part of `check` yet.

Handlebars is vendored under `vendor/handlebars-ai/`; host-provided Pi imports are linked per-package under `node_modules/@earendil-works/` for standalone tests. Do not symlink the whole `@earendil-works` directory: `npm install` can follow it and prune the Pi installation.

Operator-only changes (`PiCharter Enable/Disable/Config`, `PiPrompt Set/Reset`, `PiMnemonicCodify AgentRule/Skill`, markdown `Weave`, enabling `dream.autoPromote`) require interactive `ctx.ui.confirm` approval.
