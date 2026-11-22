import type {HelperDelegate} from './types.ts';

export type DecoratorDelegate = (
   fn: HelperDelegate,
   props: Record<string, unknown>,
   container: { partials: Map<string, unknown> },
   options: { args: unknown[]; fn: HelperDelegate; inverse?: HelperDelegate }
) => HelperDelegate;

export const registerInlineDecorator = (register: (name: string, fn: DecoratorDelegate) => void): void => {
   register('inline', (fn, props, container, options) => {
      const partials = (props.partials as Record<string, unknown> | undefined) ?? {};
      props.partials = partials;
      const partialName = options.args[0];
      if (typeof partialName === 'string') {
         partials[partialName] = options.fn;
      }
      return fn;
   });
};
