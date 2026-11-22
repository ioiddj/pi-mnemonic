/**
 * Shared LLM profile — v1.1, TypeScript half (`handlebars-ai`).
 *
 * This is an ADDITIVE file. It does not edit any of the vendored engine files;
 * it sits beside them and uses their real public API (`compile`,
 * `registerHelper`). See `SHARED-LLM-PROFILE.md` for the authoritative contract
 * and `PROVENANCE.md` for the byte-identity pins this must not disturb.
 *
 * The shared observable is the preprocess-and-render path in `renderPrompt`:
 * LLM macros are replaced with placeholder tokens *before* rendering, so a
 * result containing `{{...}}` is inserted verbatim and never re-parsed. The
 * native `createLlmHandlebarsHelpers` is an extra TS capability, not the gate.
 */

import { createHash } from "node:crypto";

import Handlebars from "./index.ts";
import type { HelperDelegate, HelperOptions, Template } from "./index.ts";

/** The three LLM helper types in the shared profile. */
export type LlmHelperType = "prompt" | "object" | "if";

/**
 * Resolved options handed to an executor. `cache` is a call-control flag and is
 * deliberately NOT part of the cache key (the shared key formula has no cache
 * field). `context` is the system prompt / context string.
 */
export interface LlmHelperOptions {
  cache: boolean;
  temperature: number;
  maxTokens: number;
  context: string;
}

/** Injectable executor. No live LLM is required; tests pass a fake. */
export type LlmExecutor = (
  type: LlmHelperType,
  prompt: string,
  options: LlmHelperOptions,
) => string;

/** Options for the prompt-compile wrapper, with LangTavern's defaults. */
export interface CompileTemplateOptions {
  /** Prompts are text, not markup. Default true: never HTML-escape. */
  noEscape?: boolean;
  /** Missing names render empty, not throw. Default false. */
  strict?: boolean;
}

/** Options for `renderPrompt`. */
export interface RenderPromptOptions {
  /** LLM executor. Defaults to one that throws rather than fabricate output. */
  executor?: LlmExecutor;
  /**
   * Default LLM context for every call in this render. It becomes the
   * executor-facing `context` unless a macro supplies its own `context` hash.
   * It never merges into the render context and never becomes render data.
   */
  llmContext?: string;
  /** Additional render context, merged over the positional context argument. */
  context?: Record<string, unknown>;
}

/** One distinct LLM call discovered during preprocessing. */
export interface LlmPendingCall {
  type: LlmHelperType;
  prompt: string;
  options: LlmHelperOptions;
  cacheKey: string;
}

/** Result of `preprocessLlmMacros`. */
export interface PreprocessResult {
  /** Source rewritten so every macro is a plain placeholder mustache. */
  template: string;
  /** Original context augmented with placeholder-token -> resolved value. */
  context: Record<string, unknown>;
  /** Distinct calls that were executed or served from cache. */
  calls: LlmPendingCall[];
}

/**
 * Canonical per-type defaults (spec v1.1 section 1, LangTavern originals).
 * These exact strings are byte-identical across both language halves because
 * they are part of the cache key: changing one changes every pinned hash.
 */
const DEFAULTS: Record<
  LlmHelperType,
  { temperature: number; maxTokens: number; context: string }
> = {
  if: {
    temperature: 0.1,
    maxTokens: 8,
    context:
      'You are a binary classifier. Answer ONLY "true" or "false". Do not explain. Respond with a single word.',
  },
  object: {
    temperature: 0.7,
    maxTokens: 512,
    context:
      "You are a structured data generator. Respond ONLY with valid JSON. No markdown fences, no explanation, just the JSON object.",
  },
  prompt: { temperature: 0.7, maxTokens: 256, context: "" },
};

/** Primary forms and aliases from spec section 2. Block (`#`) aliases stay native extras. */
const ALIASES: Record<string, LlmHelperType> = {
  "llm:prompt": "prompt",
  prompt: "prompt",
  gen: "prompt",
  generate: "prompt",
  "llm:object": "object",
  object: "object",
  obj: "object",
  "llm:if": "if",
  eval: "if",
  isTrue: "if",
};

/** The module-level cache. Exposed read-only via `getLlmCache`. */
const llmCache = new Map<string, string>();

/**
 * Raised by the default executor. The failure policy deliberately rethrows
 * this one: substituting "" here would fabricate an answer and hide a missing
 * configuration, which the shared contract forbids.
 */
export class NoLlmConfiguredError extends Error {
  constructor() {
    super(
      "No LLM configured. Pass an executor to renderPrompt/preprocessLlmMacros " +
        "(LlmExecutor = (type, prompt, options) => string), or register one via setLlmExecutor.",
    );
    this.name = "NoLlmConfiguredError";
  }
}

/** Default executor: fail loudly rather than invent an answer. */
export const noLlmConfiguredExecutor: LlmExecutor = () => {
  throw new NoLlmConfiguredError();
};

let moduleExecutor: LlmExecutor = noLlmConfiguredExecutor;

/** Set the default executor used when none is passed explicitly. */
export function setLlmExecutor(executor: LlmExecutor): void {
  moduleExecutor = executor;
}

/** Restore the throwing default executor. */
export function resetLlmExecutor(): void {
  moduleExecutor = noLlmConfiguredExecutor;
}

/** The executor used by default (the throwing one until one is set). */
export function getLlmExecutor(): LlmExecutor {
  return moduleExecutor;
}

/** Read-only view of the shared cache. */
export function getLlmCache(): ReadonlyMap<string, string> {
  return llmCache;
}

/** Empty the shared cache. */
export function clearLlmCache(): void {
  llmCache.clear();
}

/**
 * sha256 of `{type}|{prompt}|{temperature}|{maxTokens}|{context}`, first 32 hex
 * chars. Deliberately excludes the `cache` flag.
 */
export function buildLlmCacheKey(
  type: LlmHelperType,
  prompt: string,
  options: LlmHelperOptions,
): string {
  const material = `${type}|${prompt}|${options.temperature}|${options.maxTokens}|${options.context}`;
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

/** LangTavern wrapper: compile with noEscape=true, strict=false by default. */
export function compileHandlebarsTemplate(
  source: string,
  options: CompileTemplateOptions = {},
): Template {
  return Handlebars.compile(source, {
    noEscape: options.noEscape ?? true,
    strict: options.strict ?? false,
  });
}

/** Lowercase, strip non-letters, true iff it starts with `true` or `yes`. */
export function normalizeIfResult(raw: string): "true" | "false" {
  const letters = raw.toLowerCase().replace(/[^a-z]/g, "");
  return letters.startsWith("true") || letters.startsWith("yes")
    ? "true"
    : "false";
}

/**
 * Resolve inline hash values into full options with per-type defaults.
 * `defaultContext` (from `renderPrompt`'s `llmContext`) supersedes the per-type
 * default but an explicit `context` hash still wins. `max_tokens` is accepted
 * as an inline alias of the canonical `maxTokens`.
 */
function resolveOptions(
  type: LlmHelperType,
  hashes: Record<string, unknown>,
  defaultContext?: string,
): LlmHelperOptions {
  const defaults = DEFAULTS[type];
  const maxTokens =
    typeof hashes.maxTokens === "number"
      ? hashes.maxTokens
      : typeof hashes.max_tokens === "number"
        ? hashes.max_tokens
        : defaults.maxTokens;
  return {
    cache: typeof hashes.cache === "boolean" ? hashes.cache : true,
    temperature:
      typeof hashes.temperature === "number"
        ? hashes.temperature
        : defaults.temperature,
    maxTokens,
    context:
      typeof hashes.context === "string"
        ? hashes.context
        : (defaultContext ?? defaults.context),
  };
}

interface MacroMatch {
  start: number;
  end: number;
  type: LlmHelperType;
  promptRaw: string;
  argsRaw: string;
}

/**
 * Scan for non-block LLM macros. A manual scanner (not a flat regex) is used
 * because the prompt is a quoted string that may itself contain `{{...}}`, and
 * a regex would stop at the inner `}}`.
 */
function findMacros(source: string): MacroMatch[] {
  const found: MacroMatch[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) break;
    const afterOpen = open + 2;

    let nameEnd = afterOpen;
    while (nameEnd < source.length && /[A-Za-z0-9_:]/.test(source[nameEnd]!)) {
      nameEnd++;
    }
    const type = ALIASES[source.slice(afterOpen, nameEnd)];
    if (!type) {
      i = afterOpen;
      continue;
    }

    let j = nameEnd;
    while (j < source.length && /\s/.test(source[j]!)) j++;
    const quote = source[j];
    if (quote !== '"' && quote !== "'") {
      // No quoted prompt: this is a plain variable/helper, not an LLM macro.
      i = afterOpen;
      continue;
    }

    const promptStart = j;
    j++;
    let closed = false;
    while (j < source.length) {
      const ch = source[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) {
        j++;
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      i = afterOpen;
      continue;
    }

    // Scan to the unquoted closing "}}" of the whole mustache.
    let k = j;
    let innerQuote: string | null = null;
    while (k < source.length) {
      const ch = source[k]!;
      if (innerQuote) {
        if (ch === "\\") {
          k += 2;
          continue;
        }
        if (ch === innerQuote) innerQuote = null;
        k++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        innerQuote = ch;
        k++;
        continue;
      }
      if (ch === "}" && source[k + 1] === "}") break;
      k++;
    }
    if (k >= source.length) {
      i = afterOpen;
      continue;
    }

    found.push({
      start: open,
      end: k + 2,
      type,
      promptRaw: source.slice(promptStart, j),
      argsRaw: source.slice(j, k),
    });
    i = k + 2;
  }
  return found;
}

/** Parse one quoted string starting at index 0 of `raw` (escape-aware). */
function readQuoted(raw: string): { value: string; next: number } | null {
  let i = 0;
  const quote = raw[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i++]!;
    if (ch === "\\") {
      if (i >= raw.length) return null;
      out += raw[i++]!;
      continue;
    }
    if (ch === quote) return { value: out, next: i };
    out += ch;
  }
  return null;
}

/** Parse the leading prompt plus inline `key=value` hash pairs. */
function parseArgs(
  promptRaw: string,
  argsRaw: string,
): { prompt: string; hashes: Record<string, unknown> } | null {
  const parsed = readQuoted(promptRaw);
  if (!parsed) return null;
  const prompt = parsed.value;
  const hashes: Record<string, unknown> = {};
  let i = 0;
  while (i < argsRaw.length) {
    while (i < argsRaw.length && /\s/.test(argsRaw[i]!)) i++;
    if (i >= argsRaw.length) break;
    const keyStart = i;
    while (i < argsRaw.length && /[A-Za-z0-9_]/.test(argsRaw[i]!)) i++;
    if (i === keyStart) return null;
    const rawKey = argsRaw.slice(keyStart, i);
    // Inline alias from spec v1.1: `max_tokens` is the same field as `maxTokens`.
    const key = rawKey === "max_tokens" ? "maxTokens" : rawKey;
    while (i < argsRaw.length && /\s/.test(argsRaw[i]!)) i++;
    if (argsRaw[i] !== "=") return null;
    i++;
    while (i < argsRaw.length && /\s/.test(argsRaw[i]!)) i++;
    if (argsRaw[i] === '"' || argsRaw[i] === "'") {
      const value = readQuoted(argsRaw.slice(i));
      if (!value) return null;
      hashes[key] = value.value;
      i += value.next;
      continue;
    }
    const valueStart = i;
    while (i < argsRaw.length && !/\s/.test(argsRaw[i]!)) i++;
    const token = argsRaw.slice(valueStart, i);
    if (/^(true|false)$/i.test(token)) {
      hashes[key] = token.toLowerCase() === "true";
    } else if (/^-?\d+$/.test(token)) {
      hashes[key] = Number.parseInt(token, 10);
    } else if (/^-?\d*\.\d+$/.test(token)) {
      hashes[key] = Number.parseFloat(token);
    } else {
      hashes[key] = token;
    }
  }
  return { prompt, hashes };
}

/** True when `source` contains at least one recognised LLM helper macro. */
export function content_has_llm_helpers(source: string): boolean {
  return findMacros(source).length > 0;
}

/**
 * Preprocess every LLM macro into a placeholder token, executing each distinct
 * call once, honouring the cache unless `cache=false`, and applying the failure
 * policy (`"false"` for `if`, `""` otherwise) so a helper failure never aborts
 * prompt assembly.
 */
export function preprocessLlmMacros(
  source: string,
  context: Record<string, unknown> = {},
  executor: LlmExecutor = getLlmExecutor(),
  defaultContext?: string,
): PreprocessResult {
  const macros = findMacros(source);
  const augmented: Record<string, unknown> = { ...context };
  const calls: LlmPendingCall[] = [];
  const keyToToken = new Map<string, string>();
  const executed = new Set<string>();
  let counter = 0;

  const tokenFor = (key: string): string => {
    const existing = keyToToken.get(key);
    if (existing) return existing;
    let token = `__llm_${counter++}__`;
    while (Object.hasOwn(augmented, token)) token = `__llm_${counter++}__`;
    keyToToken.set(key, token);
    return token;
  };

  const execute = (
    type: LlmHelperType,
    prompt: string,
    options: LlmHelperOptions,
    key: string,
  ): string => {
    let value: string;
    try {
      value = String(executor(type, prompt, options));
    } catch (err) {
      if (err instanceof NoLlmConfiguredError) throw err;
      // Failure policy: never let a helper failure abort prompt assembly.
      value = type === "if" ? "false" : "";
    }
    if (type === "if") value = normalizeIfResult(value);
    // An explicitly uncached call must not poison the shared cache: a later
    // cached call would otherwise reuse an answer the caller asked to recompute.
    if (options.cache) llmCache.set(key, value);
    return value;
  };

  let out = "";
  let cursor = 0;
  for (const macro of macros) {
    out += source.slice(cursor, macro.start);
    const parsed = parseArgs(macro.promptRaw, macro.argsRaw);
    if (!parsed) {
      // Unparseable macro: leave it verbatim rather than guessing an answer.
      out += source.slice(macro.start, macro.end);
      cursor = macro.end;
      continue;
    }
    const options = resolveOptions(macro.type, parsed.hashes, defaultContext);
    const key = buildLlmCacheKey(macro.type, parsed.prompt, options);
    // Dedupe on (cacheKey, cache flag): a `cache=false` occurrence must not
    // share the token — or the executed call — of its `cache=true` twin.
    const dedupeKey = `${key}|${options.cache ? "cache" : "nocache"}`;
    const token = tokenFor(dedupeKey);

    if (!executed.has(dedupeKey)) {
      executed.add(dedupeKey);
      const cached = llmCache.get(key);
      if (options.cache && cached !== undefined) {
        augmented[token] = cached;
      } else {
        augmented[token] = execute(macro.type, parsed.prompt, options, key);
      }
      calls.push({
        type: macro.type,
        prompt: parsed.prompt,
        options,
        cacheKey: key,
      });
    }

    out += `{{${token}}}`;
    cursor = macro.end;
  }
  out += source.slice(cursor);

  return { template: out, context: augmented, calls };
}

/**
 * Native TS capability: build helpers backed by `cache` and register them on a
 * real handlebars environment through its `registerHelper` method. The shared
 * observable does not depend on this path.
 */
export function createLlmHandlebarsHelpers(
  cache: Map<string, string> = llmCache,
  executor: LlmExecutor = getLlmExecutor(),
): Record<string, HelperDelegate> & {
  register(env: { registerHelper(name: string, helper: HelperDelegate): void }): void;
} {
  const helpers: Record<string, HelperDelegate> = {};
  for (const [name, type] of Object.entries(ALIASES)) {
    helpers[name] = (...args: unknown[]) => {
      const optionsArg = args[args.length - 1] as HelperOptions | undefined;
      const prompt = String(args[0] ?? "");
      const options = resolveOptions(type, optionsArg?.hash ?? {});
      const key = buildLlmCacheKey(type, prompt, options);
      let value = cache.get(key);
      if (value === undefined || !options.cache) {
        try {
          value = String(executor(type, prompt, options));
        } catch (err) {
          if (err instanceof NoLlmConfiguredError) throw err;
          value = type === "if" ? "false" : "";
        }
        if (type === "if") value = normalizeIfResult(value);
        if (options.cache) cache.set(key, value);
      }
      return value;
    };
  }
  const register = (env: {
    registerHelper(name: string, helper: HelperDelegate): void;
  }): void => {
    for (const [name, helper] of Object.entries(helpers)) {
      env.registerHelper(name, helper);
    }
  };
  return Object.assign(helpers, { register });
}

/**
 * Render a prompt with the shared profile. Macros are preprocessed into
 * placeholders before rendering, so an LLM result containing `{{...}}` is never
 * re-parsed as template syntax.
 */
export function renderPrompt(
  source: string,
  context: Record<string, unknown> = {},
  options: RenderPromptOptions = {},
): string {
  const executor = options.executor ?? getLlmExecutor();
  const baseContext: Record<string, unknown> = {
    ...context,
    ...(options.context ?? {}),
  };
  const prepared = preprocessLlmMacros(source, baseContext, executor, options.llmContext);
  return compileHandlebarsTemplate(prepared.template)(prepared.context);
}
