import type { HelperDelegate, HelperOptions } from './types.ts';

const isHelperOptions = (value: unknown): value is HelperOptions =>
   typeof value === 'object' && value !== null && 'hash' in value && 'fn' in value;

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * The engine always appends the options object as the last argument, so a
 * helper taking no arguments receives *it* as `args[0]`. Reading `args[0]`
 * directly makes `{{#if}}`, `{{#each}}` and `{{#with}}` operate on the options
 * object — which is truthy and enumerable — instead of on nothing.
 */
const stripOptions = (args: unknown[]): unknown[] =>
   isHelperOptions(args.at(-1)) ? args.slice(0, -1) : args;

/**
 * Emptiness, as npm Handlebars defines it: a falsy value is empty **unless it is
 * `0`**. Handlebars keeps `0` non-empty here and gates it separately in `{{#if}}`
 * via the `includeZero` hash — so this predicate alone must never be read as
 * "truthy".
 *
 * `undefined`, `null`, `false`, `''` and `NaN` are empty; `0` is not; an empty
 * array is.
 */
export const isEmpty = (value: unknown): boolean => {
   if (!value && value !== 0) {
      return true;
   }
   if (isArray(value) && value.length === 0) {
      return true;
   }
   return false;
};

interface BlockOptions {
   hash?: Record<string, unknown>;
   fn?: (ctx: unknown, data?: Record<string, unknown>, blockParams?: unknown[]) => string;
   inverse?: (ctx: unknown, data?: Record<string, unknown>) => string;
   data?: Record<string, unknown>;
   blockParams?: string[];
}

const blockOptions = (options?: BlockOptions): BlockOptions => options ?? {};

/**
 * Truthiness for `{{#if}}` / `{{#unless}}`, exactly Handlebars' rule:
 *
 *   (!includeZero && !value) || isEmpty(value)  →  falsy
 *
 * So `0`, `''` and `NaN` are **falsy** (the same as Python and npm Handlebars),
 * and `0` becomes truthy only under an explicit `includeZero=true`.
 */
const isTruthy = (value: unknown, opts: BlockOptions): boolean => {
   if (!opts.hash?.includeZero && !value) {
      return false;
   }
   return !isEmpty(value);
};

const blockHelper = (predicate: (value: unknown, opts: BlockOptions) => boolean): HelperDelegate =>
   function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as BlockOptions | undefined;
      const opts = blockOptions(options);
      const value = stripOptions(args)[0];
      if (predicate(value, opts)) {
         return opts.fn ? opts.fn(this, opts.data) : '';
      }
      return opts.inverse ? opts.inverse(this, opts.data) : '';
   };

const inverseOrEmpty = (opts: BlockOptions, self: unknown): string =>
   opts.inverse ? opts.inverse(self, opts.data) : '';

export const builtinHelpers: Record<string, HelperDelegate> = {
   if: blockHelper((value, opts) => isTruthy(value, opts)),
   unless: blockHelper((value, opts) => !isTruthy(value, opts)),
   each: function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as BlockOptions | undefined;
      const context = stripOptions(args)[0];
      const opts = blockOptions(options);
      if (!opts?.fn) {
         return '';
      }
      let out = '';
      const baseData = opts.data ?? {};
      // Handlebars publishes @index/@key/@first/@last per iteration, and binds
      // block params as [value, key] — a separate argument, so nothing leaks
      // into the data namespace the template can read back.
      const emit = (value: unknown, key: string | number, index: number, last: boolean): void => {
         const iterData = {
            ...baseData,
            '@index': index,
            '@key': key,
            '@first': index === 0,
            '@last': last,
         };
         out += opts.fn!(value, iterData, [value, key]);
      };
      if (isArray(context)) {
         for (let i = 0; i < context.length; i += 1) {
            emit(context[i], i, i, i === context.length - 1);
         }
         if (context.length > 0) {
            return out;
         }
         return inverseOrEmpty(opts, this);
      }
      if (typeof context === 'object' && context !== null) {
         const entries = Object.keys(context as Record<string, unknown>);
         entries.forEach((key, i) => {
            emit((context as Record<string, unknown>)[key], key, i, i === entries.length - 1);
         });
         if (entries.length > 0) {
            return out;
         }
         return inverseOrEmpty(opts, this);
      }
      // Not a collection (string, number, NaN, null, undefined): Handlebars runs
      // the inverse once, never the body. Iterating a scalar is a template bug,
      // and rendering it once is the bug this branch exists to prevent.
      return inverseOrEmpty(opts, this);
   },
   with: function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as BlockOptions | undefined;
      const context = stripOptions(args)[0];
      const opts = blockOptions(options);
      // An empty context runs the INVERSE, exactly as npm does. Returning ''
      // here was a fourteenth defect, not on the thirteen-defect list: with the
      // falsy-gate fixed, `{{#with x}}…{{else}}…{{/with}}` over a falsy x took
      // neither branch and rendered nothing, where npm renders the else. It was
      // invisible to every fixture in this component's own suite.
      if (isEmpty(context) || !opts?.fn) {
         return inverseOrEmpty(opts, this);
      }
      return opts.fn(context, opts.data);
   },
   lookup: (obj: unknown, field: unknown) => {
      if (obj == null || field == null) {
         return undefined;
      }
      return (obj as Record<string | number, unknown>)[field as string | number];
   },
   log: function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as BlockOptions | undefined;
      const values = isHelperOptions(args.at(-1)) ? args.slice(0, -1) : args;
      // Allowlisted, because console[...] with an attacker-chosen key is the
      // usual prototype walk. Unknown levels fall back to console.log.
      const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
      const level = String(options?.hash?.level ?? 'log');
      const sink = console[(LEVELS as readonly string[]).includes(level) ? (level as typeof LEVELS[number]) : 'log'];
      sink(...values);
      return '';
   },
   eq: (a: unknown, b: unknown) => a === b,
   ne: (a: unknown, b: unknown) => a !== b,
   lt: (a: unknown, b: unknown) => Number(a) < Number(b),
   gt: (a: unknown, b: unknown) => Number(a) > Number(b),
   lte: (a: unknown, b: unknown) => Number(a) <= Number(b),
   gte: (a: unknown, b: unknown) => Number(a) >= Number(b),
   and: (...args: unknown[]) => {
      const values = isHelperOptions(args.at(-1)) ? args.slice(0, -1) : args;
      return values.every(Boolean);
   },
   or: (...args: unknown[]) => {
      const values = isHelperOptions(args.at(-1)) ? args.slice(0, -1) : args;
      return values.some(Boolean);
   },
   not: (value: unknown) => !value,
   blockHelperMissing: function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as BlockOptions | undefined;
      const context = args[0];
      const opts = blockOptions(options);
      const inverse = opts.inverse;
      const fn = opts.fn;
      if (!fn) {
         return '';
      }
      if (context === true) {
         return fn(this, opts.data);
      }
      if (context === false || context == null) {
         return inverse ? inverse(this, opts.data) : '';
      }
      if (isArray(context)) {
         if (context.length > 0) {
            return builtinHelpers.each!.call(this, context, opts);
         }
         return inverse ? inverse(this, opts.data) : '';
      }
      return fn(context, opts.data);
   },
};
