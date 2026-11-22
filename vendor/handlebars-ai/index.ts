/**
 * In-repo Handlebars-compatible template compiler (supply-chain replacement).
 * API surface matches the subset used in this repo; parity tests track npm handlebars.
 */
import {registerDefaultDecorators} from './applyDecorators.ts';
import {builtinHelpers} from './builtins.ts';
import { compileTemplate, type RuntimeState } from './evaluate.ts';
import type { CompileOptions, HandlebarsEnvironment, HelperDelegate, Template } from './types.ts';
import type {DecoratorDelegate} from './decorators.ts';

export type { CompileOptions, HelperDelegate, HelperOptions, Template } from './types.ts';
export type {DecoratorDelegate} from './decorators.ts';

const createState = (compileOptions: CompileOptions = {}): RuntimeState => {
   const decorators = new Map<string, DecoratorDelegate>();
   registerDefaultDecorators((name, fn) => {
      decorators.set(name, fn);
   });
   return { helpers: new Map(Object.entries(builtinHelpers)), decorators, partials: new Map(), compileOptions };
};

export class HandlebarsImpl implements HandlebarsEnvironment {
   private readonly state: RuntimeState;

   constructor(compileDefaults: CompileOptions = {}) {
      this.state = createState(compileDefaults);
   }

   registerHelper(name: string, helper: HelperDelegate): void {
      this.state.helpers.set(name, helper);
   }

   unregisterHelper(name: string): void {
      this.state.helpers.delete(name);
   }

   registerPartial(name: string, template: string | Template): void {
      this.state.partials.set(name, template);
   }

   registerDecorator(name: string, decorator: DecoratorDelegate): void {
      this.state.decorators.set(name, decorator);
   }

   unregisterDecorator(name: string): void {
      this.state.decorators.delete(name);
   }

   compile(template: string, options: CompileOptions = {}): Template {
      const merged: RuntimeState = {
         ...this.state,
         helpers: new Map(this.state.helpers),
         decorators: new Map(this.state.decorators),
         partials: new Map(this.state.partials),
         compileOptions: { ...this.state.compileOptions, ...options },
      };
      return compileTemplate(template, merged);
   }

   static create(): HandlebarsImpl {
      return new HandlebarsImpl();
   }
}

const defaultEnv = new HandlebarsImpl();

const Handlebars = {
   compile: (template: string, options?: CompileOptions) => defaultEnv.compile(template, options),
   registerHelper: (name: string, helper: HelperDelegate) => defaultEnv.registerHelper(name, helper),
   unregisterHelper: (name: string) => defaultEnv.unregisterHelper(name),
   registerPartial: (name: string, partial: string | Template) => defaultEnv.registerPartial(name, partial),
   registerDecorator: (name: string, decorator: DecoratorDelegate) => defaultEnv.registerDecorator(name, decorator),
   unregisterDecorator: (name: string) => defaultEnv.unregisterDecorator(name),
   create: () => HandlebarsImpl.create(),
};

export default Handlebars;
export {Handlebars};
