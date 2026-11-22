import type { CompileOptions, Expr, Stmt } from './types.ts';

const DEFAULT_KNOWN_HELPERS: Record<string, boolean> = {
   helperMissing: true,
   blockHelperMissing: true,
   each: true,
   if: true,
   unless: true,
   with: true,
   log: true,
   lookup: true,
};

export const mergeKnownHelpers = (options: CompileOptions): Record<string, boolean> => ({
   ...DEFAULT_KNOWN_HELPERS,
   ...options.knownHelpers,
});

const helperNameFromExpr = (expr: Expr): string | undefined => {
   if (expr.kind === 'subexpr' && typeof expr.name === 'string') {
      return expr.name;
   }
   if (expr.kind === 'path') {
      return expr.path;
   }
   return undefined;
};

const assertHelperAllowed = (name: string, options: CompileOptions, definite: boolean): void => {
   const known = mergeKnownHelpers(options);
   if (known[name]) {
      return;
   }
   if (definite && options.knownHelpersOnly) {
      throw new Error(`You specified knownHelpersOnly, but used the unknown helper ${name}`);
   }
};

const validateExpr = (expr: Expr, options: CompileOptions, definite: boolean): void => {
   if (expr.kind === 'subexpr') {
      const name = helperNameFromExpr(expr);
      if (name) {
         assertHelperAllowed(name, options, true);
      }
      for (const param of expr.params) {
         validateExpr(param, options, false);
      }
      for (const valueExpr of Object.values(expr.hash)) {
         validateExpr(valueExpr, options, false);
      }
      return;
   }
   if (expr.kind === 'path' && definite && options.knownHelpersOnly) {
      const known = mergeKnownHelpers(options);
      if (known[expr.path]) {
         assertHelperAllowed(expr.path, options, true);
      }
   }
};

const validateStmt = (stmt: Stmt, options: CompileOptions): void => {
   switch (stmt.kind) {
      case 'mustache':
         if (stmt.expr.kind === 'subexpr') {
            validateExpr(stmt.expr, options, true);
         } else if (stmt.expr.kind === 'path' && options.knownHelpersOnly) {
            validateExpr(stmt.expr, options, true);
         }
         break;
      case 'block': {
         const name = typeof stmt.name === 'string' ? stmt.name : helperNameFromExpr(stmt.name as Expr);
         if (name) {
            assertHelperAllowed(name, options, true);
         }
         for (const param of stmt.params) {
            validateExpr(param, options, false);
         }
         for (const valueExpr of Object.values(stmt.hash)) {
            validateExpr(valueExpr, options, false);
         }
         for (const child of [...stmt.program, ...stmt.inverse]) {
            validateStmt(child, options);
         }
         break;
      }
      case 'partial':
      case 'partialBlock':
         for (const param of stmt.params) {
            validateExpr(param, options, false);
         }
         for (const valueExpr of Object.values(stmt.hash)) {
            validateExpr(valueExpr, options, false);
         }
         if (stmt.kind === 'partialBlock') {
            for (const child of stmt.program) {
               validateStmt(child, options);
            }
         }
         break;
      case 'decoratorBlock':
         for (const param of stmt.params) {
            validateExpr(param, options, false);
         }
         for (const child of stmt.program) {
            validateStmt(child, options);
         }
         break;
      default:
         break;
   }
};

export const validateProgram = (program: Stmt[], options: CompileOptions): void => {
   for (const stmt of program) {
      validateStmt(stmt, options);
   }
};

export const isKnownHelperName = (name: string, options: CompileOptions): boolean => Boolean(mergeKnownHelpers(options)[name]);
