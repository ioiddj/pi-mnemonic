import {applyCompileTimeDecorators} from './applyDecorators.ts';
import {escapeExpression} from './escape.ts';
import {builtinHelpers} from './builtins.ts';
import type {DecoratorDelegate} from './decorators.ts';
import {parseTemplate} from './parse.ts';
import { isKnownHelperName, validateProgram } from './validate.ts';
import type { CompileOptions, Expr, HelperDelegate, HelperOptions, Stmt, Template } from './types.ts';

export interface RuntimeState {
   helpers: Map<string, HelperDelegate>;
   decorators: Map<string, DecoratorDelegate>;
   partials: Map<string, string | Template>;
   compileOptions: CompileOptions;
}

const wrapContext = (ctx: unknown, parent: unknown): unknown => {
   if (ctx === parent) {
      return ctx;
   }
   if (typeof ctx === 'object' && ctx !== null) {
      return { ...(ctx as Record<string, unknown>), _parent: parent };
   }
   return ctx;
};

const bindBlockContext = (ctx: unknown, parent: unknown, blockParams: string[], override?: unknown[]): unknown => {
   if (blockParams.length === 0) {
      return wrapContext(ctx, parent);
   }
   // Explicit override (`{{#each xs as |v k|}}` supplies [value, key]) takes
   // precedence, so a two-param block is never bound from the item's own keys.
   if (override && override.length === blockParams.length) {
      const bound: Record<string, unknown> = { _parent: parent };
      blockParams.forEach((name, i) => {
         bound[name] = override[i];
      });
      return bound;
   }
   if (blockParams.length === 1) {
      return { [blockParams[0]!]: ctx, _parent: parent };
   }
   const frame: Record<string, unknown> = { _parent: parent };
   if (typeof ctx === 'object' && ctx !== null && !Array.isArray(ctx)) {
      for (const name of blockParams) {
         frame[name] = (ctx as Record<string, unknown>)[name];
      }
      return frame;
   }
   blockParams.forEach((name, index) => {
      frame[name] = Array.isArray(ctx) ? ctx[index] : ctx;
   });
   return frame;
};

/** Walk a dot/slash path from a base value. Shared by data vars and context paths. */
const walkSegments = (base: unknown, segments: string[]): unknown => {
   let current: unknown = base;
   for (const segment of segments) {
      if (segment === 'this') {
         continue;
      }
      if (segment === '..') {
         current = (current as { _parent?: unknown })?._parent;
         continue;
      }
      if (current == null || typeof current !== 'object') {
         return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
   }
   return current;
};

const resolvePath = (context: unknown, path: string, root: Record<string, unknown>, data: Record<string, unknown>): unknown => {
   if (path === 'this') {
      return context;
   }
   if (path === '@root' || path === '@root.') {
      return data.root ?? root;
   }
   if (path.startsWith('@')) {
      const key = path.slice(1);
      if (key in data) {
         return data[key];
      }
      if (data[`@${key}`] !== undefined) {
         return data[`@${key}`];
      }
      // Deep data paths: {{@root.user.name}} and {{@index.foo}} resolve the head
      // data variable and then walk the remainder, rather than failing whole.
      const segments = key.split('.');
      const head = segments.shift();
      let base: unknown = head !== undefined ? (head in data ? data[head] : data[`@${head}`]) : undefined;
      if (base === undefined) {
         return undefined;
      }
      return walkSegments(base, segments);
   }

   let base: unknown = context;
   let segments = path.split(/[./]/).filter(Boolean);
   if (path.startsWith('../')) {
      const ups = (path.match(/\.\.\//g) ?? []).length;
      base = context;
      for (let i = 0; i < ups; i += 1) {
         base = (base as { _parent?: unknown })?._parent ?? root;
      }
      segments = path
         .replace(/^(\.\.\/)+/, '')
         .split(/[./]/)
         .filter(Boolean);
   }

   return walkSegments(base, segments);
};

const invokeHelper = (
   helper: HelperDelegate,
   helperName: string,
   params: Expr[],
   hashExprs: Record<string, Expr>,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): unknown => {
   const evaluatedParams = params.map(param => evaluateExpr(param, context, root, state, data));
   const hash: Record<string, unknown> = {};
   for (const [key, valueExpr] of Object.entries(hashExprs)) {
      hash[key] = evaluateExpr(valueExpr, context, root, state, data);
   }
   const inlineOptions: HelperOptions = { hash, data, name: helperName, fn: () => '', inverse: () => '' };
   return helper(...evaluatedParams, inlineOptions);
};

const lookupHelper = (name: string, state: RuntimeState): HelperDelegate | undefined =>
   state.helpers.get(name) ?? builtinHelpers[name];

const evaluateExpr = (
   expr: Expr,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): unknown => {
   if (expr.kind === 'literal') {
      return expr.value;
   }
   if (expr.kind === 'path') {
      return resolvePath(context, expr.path, root, data);
   }
   const helperName = typeof expr.name === 'string' ? expr.name : String(evaluateExpr(expr.name, context, root, state, data));
   const helper = lookupHelper(helperName, state);
   if (!helper) {
      const missing = state.helpers.get('helperMissing');
      if (missing) {
         return missing(helperName, { hash: {}, fn: () => '', inverse: () => '', data, name: helperName });
      }
      if (state.compileOptions.strict) {
         throw new Error(`Missing helper: ${helperName}`);
      }
      return `{{${helperName}}}`;
   }
   return invokeHelper(helper, helperName, expr.params, expr.hash, context, root, state, data);
};

const evaluateMustacheExpr = (
   expr: Expr,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): unknown => {
   if (expr.kind === 'path') {
      const helper = lookupHelper(expr.path, state);
      if (helper && (!state.compileOptions.knownHelpersOnly || isKnownHelperName(expr.path, state.compileOptions))) {
         return invokeHelper(helper, expr.path, [], {}, context, root, state, data);
      }
      return resolvePath(context, expr.path, root, data);
   }
   return evaluateExpr(expr, context, root, state, data);
};

const resolveName = (
   name: string | Expr,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): string => {
   if (typeof name === 'string') {
      return name;
   }
   if (name.kind === 'path') {
      return name.path;
   }
   return String(evaluateExpr(name, context, root, state, data));
};

const renderPartial = (
   partialName: string,
   params: Expr[],
   hashExprs: Record<string, Expr>,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>,
   extraPartials?: Map<string, string | Template>
): string => {
   const partials = extraPartials ? new Map([...state.partials, ...extraPartials]) : state.partials;
   const partial = partials.get(partialName);
   if (!partial) {
      if (state.compileOptions.strict) {
         throw new Error(`The partial ${partialName} could not be found`);
      }
      return '';
   }
   const hash: Record<string, unknown> = {};
   for (const [key, valueExpr] of Object.entries(hashExprs)) {
      hash[key] = evaluateExpr(valueExpr, context, root, state, data);
   }
   const partialContext =
      params.length > 0
         ? evaluateExpr(params[0]!, context, root, state, data)
         : Object.keys(hash).length > 0
           ? { ...(context as Record<string, unknown>), ...hash }
           : context;
   const childState: RuntimeState = { ...state, partials };
   const template = typeof partial === 'string' ? compileTemplate(partial, childState) : partial;
   return template(partialContext as Record<string, unknown>, {data});
};

export const compileProgram = (program: Stmt[], state: RuntimeState): Template => {
   return (context: Record<string, unknown> = {}, renderOptions?: { data?: Record<string, unknown> }) => {
      const data = { ...(renderOptions?.data ?? {}), root: renderOptions?.data?.root ?? context };
      const root: Record<string, unknown> = { ...context, _data: data };
      return renderProgram(program, context, root, state, data);
   };
};

const renderProgram = (
   program: Stmt[],
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): string => {
   let out = '';
   for (const stmt of program) {
      out += renderStmt(stmt, context, root, state, data);
   }
   return out;
};

const renderStmt = (
   stmt: Stmt,
   context: unknown,
   root: Record<string, unknown>,
   state: RuntimeState,
   data: Record<string, unknown>
): string => {
   switch (stmt.kind) {
      case 'content':
         return stmt.value;
      case 'comment':
         return '';
      case 'rawBlock': {
         const rawHelper = state.helpers.get('raw');
         if (!rawHelper) {
            return stmt.body;
         }
         const rawOptions: HelperOptions = { name: 'raw', hash: {}, data, fn: () => stmt.body, inverse: () => '' };
         const rawResult = rawHelper.call(context, rawOptions);
         return rawResult == null ? '' : String(rawResult);
      }
      case 'partial':
         return renderPartial(
            resolveName(stmt.name, context, root, state, data),
            stmt.params,
            stmt.hash,
            context,
            root,
            state,
            data
         );
      case 'partialBlock': {
         const partialName = resolveName(stmt.name, context, root, state, data);
         const partialBlockTemplate = compileProgram(stmt.program, state);
         const extraPartials = new Map<string, string | Template>([['@partial-block', partialBlockTemplate]]);
         return renderPartial(partialName, stmt.params, stmt.hash, context, root, state, data, extraPartials);
      }
      case 'decoratorBlock': {
         if (stmt.name === 'inline') {
            return '';
         }
         const programFn = () => renderProgram(stmt.program, context, root, state, data);
         const decorator = state.decorators.get(stmt.name);
         if (!decorator) {
            return '';
         }
         const args = stmt.params.map(param => evaluateExpr(param, context, root, state, data));
         const props: Record<string, unknown> = {};
         const wrapped = decorator(() => '', props, { partials: state.partials }, { args, fn: programFn });
         const result = (wrapped as () => string)();
         return result == null ? '' : String(result);
      }
      case 'mustache': {
         const value = evaluateMustacheExpr(stmt.expr, context, root, state, data);
         // Only null/undefined render as ''. `false` renders as the string
         // "false" — npm Handlebars' escapeExpression(false) is `'' + false`,
         // and {{@last}} would be unprintable without it.
         if (value == null) {
            return '';
         }
         const text = String(value);
         return stmt.escape && !state.compileOptions.noEscape ? escapeExpression(text) : text;
      }
      case 'block': {
         const helperName = typeof stmt.name === 'string' ? stmt.name : String(stmt.name);
         let helper = state.helpers.get(helperName) ?? builtinHelpers[helperName];
         const params = stmt.params.map(param => evaluateExpr(param, context, root, state, data));
         const hash: Record<string, unknown> = {};
         for (const [key, valueExpr] of Object.entries(stmt.hash)) {
            hash[key] = evaluateExpr(valueExpr, context, root, state, data);
         }
         const dataWithRoot = { ...data, root: data.root ?? context };
         const options: HelperOptions = {
            name: helperName,
            hash,
            data: dataWithRoot,
            blockParams: stmt.blockParams,
            fn: (ctx = context, iterData?: Record<string, unknown>, iterBlockParams?: unknown[]) =>
               renderProgram(
                  stmt.program,
                  bindBlockContext(ctx, context, stmt.blockParams, iterBlockParams),
                  root,
                  state,
                  { ...dataWithRoot, ...iterData },
               ),
            inverse: (ctx = context, iterData?: Record<string, unknown>, iterBlockParams?: unknown[]) =>
               renderProgram(
                  stmt.inverse,
                  bindBlockContext(ctx, context, stmt.blockParams, iterBlockParams),
                  root,
                  state,
                  { ...dataWithRoot, ...iterData },
               ),
         };
         if (!helper) {
            helper = builtinHelpers.blockHelperMissing;
            if (!helper) {
               if (state.compileOptions.strict) {
                  throw new Error(`Missing block helper: ${helperName}`);
               }
               return '';
            }
            const result = helper.call(context, undefined, options);
            return result == null ? '' : String(result);
         }
         const result = helper(...params, options);
         return result == null ? '' : String(result);
      }
      default:
         return '';
   }
};

export const compileTemplate = (source: string, state: RuntimeState): Template => {
   const program = parseTemplate(source);
   validateProgram(program, state.compileOptions);
   applyCompileTimeDecorators(program, state);
   return compileProgram(program, state);
};
