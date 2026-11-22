const ESCAPE: Record<string, string> = {
   '&': '&amp;',
   '<': '&lt;',
   '>': '&gt;',
   '"': '&quot;',
   "'": '&#x27;',
   '`': '&#x60;',
   '=': '&#x3D;',
};

export const escapeExpression = (value: unknown): string => {
   // null and undefined render as ''. `false` renders as "false", because
   // Handlebars' rule for a non-string is `'' + value` once `toHTML`,
   // `== null` and `!value` have been ruled out — and `!value` is what swallows
   // `false`, so it is not swallowed here either.
   if (value == null) {
      return '';
   }
   const str = typeof value === 'string' ? value : String(value);
   return str.replace(/[&<>"'`=]/g, ch => ESCAPE[ch] ?? ch);
};
