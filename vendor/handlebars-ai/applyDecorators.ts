import {registerInlineDecorator} from './decorators.ts';
import {compileProgram} from './evaluate.ts';
import type {DecoratorDelegate} from './decorators.ts';
import type { Stmt } from './types.ts';
// RuntimeState is declared in ./evaluate.ts, not ./types.ts — an upstream
// mistake that upstream never sees because its typecheck excludes src/lib/vendor.
// Required here: tsconfig `exclude` does NOT stop tsc checking a file that is
// imported, so this copy cannot be vendored without fixing it. Type-only, so
// runtime behaviour is unchanged. See PROVENANCE.md.
import type { RuntimeState } from './evaluate.ts';

const walk = (program: Stmt[], visit: (stmt: Stmt) => void): void => {
   for (const stmt of program) {
      visit(stmt);
      if (stmt.kind === 'block') {
         walk(stmt.program, visit);
         walk(stmt.inverse, visit);
      } else if (stmt.kind === 'partialBlock' || stmt.kind === 'decoratorBlock') {
         walk(stmt.program, visit);
      }
   }
};

export const applyCompileTimeDecorators = (program: Stmt[], state: RuntimeState): void => {
   walk(program, stmt => {
      if (stmt.kind !== 'decoratorBlock') {
         return;
      }
      const decorator = state.decorators.get(stmt.name);
      if (!decorator) {
         return;
      }
      const programFn = compileProgram(stmt.program, state);
      const props: Record<string, unknown> = {};
      const container = { partials: state.partials };
      const args = stmt.params.map(param => {
         if (param.kind === 'literal') {
            return param.value;
         }
         if (param.kind === 'path') {
            return param.path;
         }
         return undefined;
      });
      // Upstream's declared delegate shape is narrower than the value passed here, and
      // only a type-checker that skips src/lib/vendor ever sees it. Both arguments are
      // cast at the boundary: the first is a compiled Template where a helper delegate
      // is declared, the fourth is the partial-block delegate. Type-only, no runtime
      // change. See PROVENANCE.md.
      decorator(
        programFn as unknown as Parameters<typeof decorator>[0],
        props,
        container,
        { args, fn: programFn as unknown as Parameters<typeof decorator>[3] extends { fn: infer F } ? F : never },
      )
      const registered = props.partials as Record<string, unknown> | undefined;
      if (registered) {
         for (const [name, template] of Object.entries(registered)) {
            state.partials.set(name, template as string);
         }
      }
   });
};

export const registerDefaultDecorators = (register: (name: string, fn: DecoratorDelegate) => void): void => {
   registerInlineDecorator(register);
};
