export interface HelperOptions<T = unknown> {
   name?: string;
   hash: Record<string, unknown>;
   data?: Record<string, unknown>;
   blockParams?: string[];
   fn: (context?: T, data?: Record<string, unknown>, blockParams?: unknown[]) => string;
   inverse: (context?: T, data?: Record<string, unknown>) => string;
   loc?: { start: number; end: number };
}

export type HelperDelegate<T = unknown> = (...args: unknown[]) => unknown;

export interface Template<T = Record<string, unknown>> {
   (context?: T, options?: { data?: Record<string, unknown> }): string;
}

export interface CompileOptions {
   noEscape?: boolean;
   strict?: boolean;
   knownHelpers?: Record<string, boolean>;
   knownHelpersOnly?: boolean;
}

export interface HandlebarsEnvironment {
   registerHelper(name: string, helper: HelperDelegate): void;
   unregisterHelper(name: string): void;
   registerPartial(name: string, template: string | Template): void;
   registerDecorator(name: string, decorator: import('./decorators.ts').DecoratorDelegate): void;
   unregisterDecorator(name: string): void;
   compile(template: string, options?: CompileOptions): Template;
}

export type Expr =
   | { kind: 'path'; path: string }
   | { kind: 'literal'; value: string | number | boolean | null | undefined }
   | { kind: 'subexpr'; name: string | Expr; params: Expr[]; hash: Record<string, Expr> };

export type Stmt =
   | { kind: 'content'; value: string }
   | { kind: 'comment'; value: string }
   | { kind: 'mustache'; expr: Expr; escape: boolean }
   | {
        kind: 'block';
        name: string | Expr;
        params: Expr[];
        hash: Record<string, Expr>;
        blockParams: string[];
        program: Stmt[];
        inverse: Stmt[];
     }
   | { kind: 'decoratorBlock'; name: string; params: Expr[]; hash: Record<string, Expr>; program: Stmt[] }
   | { kind: 'partial'; name: string | Expr; params: Expr[]; hash: Record<string, Expr> }
   | { kind: 'partialBlock'; name: string | Expr; params: Expr[]; hash: Record<string, Expr>; program: Stmt[] }
   | { kind: 'rawBlock'; body: string };
