import type { Expr, Stmt } from './types.ts';

const stripWhitespace = (value: string): string => value.replace(/^[\s~]+|[\s~]+$/g, '');

const isIdentStart = (ch: string): boolean => /[A-Za-z_@$]/.test(ch) || ch === '.';

const readString = (input: string, start: number, quote: string): { value: string; end: number } => {
   let value = '';
   let i = start + 1;
   while (i < input.length) {
      const ch = input[i] ?? "";
      if (ch === '\\' && i + 1 < input.length) {
         value += input[i + 1];
         i += 2;
         continue;
      }
      if (ch === quote) {
         return { value, end: i + 1 };
      }
      value += ch;
      i += 1;
   }
   throw new Error('Unclosed string in expression');
};

const readNumber = (input: string, start: number): { value: number; end: number } => {
   let i = start;
   while (i < input.length && /[0-9.]/.test(input[i] ?? '')) {
      i += 1;
   }
   return { value: Number(input.slice(start, i)), end: i };
};

const readPath = (input: string, start: number): { value: string; end: number } => {
   let i = start;
   while (i < input.length) {
      // `?? ""` not `!`: an empty string fails the character test exactly as a
      // break should, so behaviour is unchanged and only the type is.
      const ch = input[i] ?? "";
      if (/[A-Za-z0-9_@$./:-]/.test(ch)) {
         i += 1;
         continue;
      }
      break;
   }
   return { value: input.slice(start, i), end: i };
};

const tokenizeExpr = (input: string): string[] => {
   const tokens: string[] = [];
   let i = 0;
   while (i < input.length) {
      while (i < input.length && /\s/.test(input[i] ?? '')) {
         i += 1;
      }
      if (i >= input.length) {
         break;
      }
      const ch = input[i] ?? "";
      if (ch === '"' || ch === "'") {
         const { value, end } = readString(input, i, ch);
         tokens.push(JSON.stringify(value));
         i = end;
         continue;
      }
      if (ch === '(') {
         let depth = 1;
         let j = i + 1;
         while (j < input.length && depth > 0) {
            if (input[j] === '(') {
               depth += 1;
            } else if (input[j] === ')') {
               depth -= 1;
            }
            j += 1;
         }
         tokens.push(input.slice(i, j));
         i = j;
         continue;
      }
      if (/[0-9]/.test(ch)) {
         const { value, end } = readNumber(input, i);
         tokens.push(String(value));
         i = end;
         continue;
      }
      if (ch === '=') {
         tokens.push('=');
         i += 1;
         continue;
      }
      if (isIdentStart(ch)) {
         const { value, end } = readPath(input, i);
         tokens.push(value);
         i = end;
         continue;
      }
      throw new Error(`Unexpected character in expression: ${ch}`);
   }
   return tokens;
};

const parseLiteral = (token: string): Expr => {
   if (token === 'true') {
      return { kind: 'literal', value: true };
   }
   if (token === 'false') {
      return { kind: 'literal', value: false };
   }
   if (token === 'null') {
      return { kind: 'literal', value: null };
   }
   if (token === 'undefined') {
      return { kind: 'literal', value: undefined };
   }
   if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return { kind: 'literal', value: JSON.parse(token) as string };
   }
   if (/^-?\d+(\.\d+)?$/.test(token)) {
      return { kind: 'literal', value: Number(token) };
   }
   if (token.startsWith('(') && token.endsWith(')')) {
      return parseCallExpr(token.slice(1, -1).trim());
   }
   return { kind: 'path', path: token };
};

const parseCallExpr = (input: string): Expr => {
   const tokens = tokenizeExpr(input);
   if (tokens.length === 0) {
      throw new Error('Empty expression');
   }
   if (tokens.length === 1) {
      return parseLiteral(tokens[0]!);
   }
   const nameToken = tokens.shift()!;
   const nameExpr = parseLiteral(nameToken);
   const name = nameExpr.kind === 'path' ? nameExpr.path : nameExpr;
   const params: Expr[] = [];
   const hash: Record<string, Expr> = {};
   while (tokens.length > 0) {
      const token = tokens.shift()!;
      if (token === '=') {
         const key = params.pop();
         const valueToken = tokens.shift();
         if (!key || key.kind !== 'path' || !valueToken) {
            throw new Error('Invalid hash pair');
         }
         hash[key.path] = parseLiteral(valueToken);
         continue;
      }
      params.push(parseLiteral(token));
   }
   if (typeof name === 'string') {
      return { kind: 'subexpr', name, params, hash };
   }
   return { kind: 'subexpr', name, params, hash };
};

const parseBlockOpenBody = (body: string): { exprBody: string; blockParams: string[] } => {
   const match = body.match(/\s+as\s+\|([^|]*)\|\s*$/);
   if (!match) {
      return { exprBody: body, blockParams: [] };
   }
   const blockParams = match[1]!.trim().split(/\s+/).filter(Boolean);
   return { exprBody: body.slice(0, match.index).trim(), blockParams };
};

export const parseMustacheInner = (raw: string): { type: string; expr: Expr; name?: string; blockParams?: string[] } => {
   const inner = stripWhitespace(raw);
   if (!inner) {
      throw new Error('Empty mustache');
   }
   if (inner.startsWith('!')) {
      return { type: 'comment', expr: { kind: 'literal', value: inner.slice(1).trim() } };
   }
   if (inner.startsWith('#>')) {
      const call = parseCallExpr(inner.slice(2).trim());
      return { type: 'partialBlock', expr: call };
   }
   if (inner.startsWith('>')) {
      const call = parseCallExpr(inner.slice(1).trim());
      return { type: 'partial', expr: call };
   }
   if (inner.startsWith('#*')) {
      const {exprBody} = parseBlockOpenBody(inner.slice(2).trim());
      const call = parseCallExpr(exprBody);
      return { type: 'decoratorBlock', expr: call };
   }
   if (inner.startsWith('#')) {
      const { exprBody, blockParams } = parseBlockOpenBody(inner.slice(1).trim());
      const call = parseCallExpr(exprBody);
      return { type: 'block', expr: call, blockParams };
   }
   if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      return { type: 'close', expr: { kind: 'path', path: name }, name };
   }
   if (inner.startsWith('^')) {
      const call = parseCallExpr(inner.slice(1).trim());
      return { type: 'inverse', expr: call };
   }
   if (inner.startsWith('else')) {
      const rest = inner.slice(4).trim();
      if (!rest) {
         return { type: 'else', expr: { kind: 'literal', value: '' } };
      }
      const call = parseCallExpr(rest);
      return { type: 'else', expr: call };
   }
   if (inner.startsWith('&')) {
      return { type: 'mustache', expr: parseCallExpr(inner.slice(1).trim()) };
   }
   if (inner.startsWith('{') && inner.endsWith('}')) {
      return { type: 'mustache', expr: parseCallExpr(inner.slice(1, -1).trim()) };
   }
   return { type: 'mustache', expr: parseCallExpr(inner) };
};

const blockName = (expr: Expr): string => {
   if (expr.kind === 'subexpr') {
      return typeof expr.name === 'string' ? expr.name : blockName(expr.name);
   }
   if (expr.kind === 'path') {
      return expr.path;
   }
   throw new Error('Invalid block name');
};

const exprParts = (expr: Expr): { name: string | Expr; params: Expr[]; hash: Record<string, Expr> } => {
   if (expr.kind === 'subexpr') {
      return { name: expr.name, params: expr.params, hash: expr.hash };
   }
   if (expr.kind === 'path') {
      return { name: expr.path, params: [], hash: {} };
   }
   throw new Error('Expected helper expression');
};

const RAW_OPEN_RE = /^\{\{\{\{([^!"#%-, ./;->@[-^`{-~]+)\}\}\}\}/;
const RAW_CLOSE_RE = (name: string) =>
   new RegExp(`^([\\s\\S]*?)\\{\\{\\{\\{/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[=}\\s/.])\\}\\}\\}\\}`);

interface OpenBlock {
   frame: 'block';
   name: string;
   /**
    * The name the closing tag must carry, when it differs from the helper name.
    * Only `{{^foo}}…{{/foo}}` needs it: the section renders as `unless`, but
    * Handlebars still closes it with `/foo`.
    */
   closeName?: string;
   params: Expr[];
   hash: Record<string, Expr>;
   blockParams: string[];
   program: Stmt[];
   inverse: Stmt[];
   elseIfChain: Array<{ params: Expr[]; hash: Record<string, Expr>; program: Stmt[] }>;
   openInverse: boolean;
   inElseIf: boolean;
}

interface OpenPartialBlock {
   frame: 'partialBlock';
   name: string;
   params: Expr[];
   hash: Record<string, Expr>;
   program: Stmt[];
}

interface OpenDecoratorBlock {
   frame: 'decoratorBlock';
   name: string;
   params: Expr[];
   hash: Record<string, Expr>;
   program: Stmt[];
}

type StackFrame = OpenBlock | OpenPartialBlock | OpenDecoratorBlock;

const isOpenBlock = (frame: StackFrame | undefined): frame is OpenBlock => frame?.frame === 'block';

export const parseTemplate = (source: string): Stmt[] => {
   const statements: Stmt[] = [];
   const stack: StackFrame[] = [];
   let index = 0;
   /**
    * Whitespace control (`{{~x~}}`). `stripWhitespace` already strips the `~`
    * out of the *expression*; these two flags do the outward half Handlebars
    * does — `~` on the left eats the whitespace before the tag, `~` on the
    * right eats the whitespace after it. Only the immediate sibling text is
    * touched; a non-content statement clears the pending trim, so whitespace
    * control can never reach past the next tag.
    */
   let pendingLeadingTrim = false;

   const pushContent = (text: string) => {
      const value = pendingLeadingTrim ? text.replace(/^\s+/, '') : text;
      pendingLeadingTrim = false;
      if (!value) {
         return;
      }
      const body = currentBody();
      const last = body.at(-1);
      if (last?.kind === 'content') {
         last.value += value;
         return;
      }
      body.push({ kind: 'content', value });
   };

   const trimTrailingWhitespace = () => {
      const body = currentBody();
      const last = body.at(-1);
      if (last?.kind === 'content') {
         last.value = last.value.replace(/\s+$/, '');
      }
   };

   const currentBody = (): Stmt[] => {
      if (stack.length === 0) {
         return statements;
      }
      const top = stack[stack.length - 1];
      if (!top) {
         return statements;
      }
      if (top.frame === 'partialBlock' || top.frame === 'decoratorBlock') {
         return top.program;
      }
      if (top.openInverse) {
         if (top.inElseIf && top.elseIfChain.length > 0) {
            return top.elseIfChain[top.elseIfChain.length - 1]!.program;
         }
         return top.inverse;
      }
      return top.program;
   };

   while (index < source.length) {
      const quad = source.indexOf('{{{{', index);
      const dbl = source.indexOf('{{', index);

      if (dbl < 0 && quad < 0) {
         pushContent(source.slice(index));
         break;
      }

      const nextTag = quad >= 0 && (quad < dbl || dbl < 0) ? quad : dbl;
      pushContent(source.slice(index, nextTag));

      if (nextTag === quad) {
         const rest = source.slice(quad);
         const openMatch = rest.match(RAW_OPEN_RE);
         if (!openMatch) {
            throw new Error('Invalid raw block open tag');
         }
         const rawName = openMatch[1]!.trim();
         index = quad + openMatch[0].length;
         const bodyMatch = source.slice(index).match(RAW_CLOSE_RE(rawName));
         if (!bodyMatch) {
            throw new Error(`Unclosed raw block: ${rawName}`);
         }
         currentBody().push({ kind: 'rawBlock', body: bodyMatch[1] ?? '' });
         index += bodyMatch[0].length;
         continue;
      }

      const open = dbl;
      const close = source.indexOf('}}', open + 2);
      if (close < 0) {
         throw new Error('Unclosed mustache');
      }
      const triple = source.slice(open, open + 3) === '{{{';
      const rawClose = triple ? source.indexOf('}}}', open + 3) : close;
      const tagBody = triple ? source.slice(open + 3, rawClose) : source.slice(open + 2, close);
      const tagEnd = triple ? rawClose + 3 : close + 2;
      // Read the `~` before parseMustacheInner strips it, then apply the trim to
      // the text statement immediately preceding this tag.
      const trimBeforeTag = tagBody.startsWith('~');
      if (trimBeforeTag) {
         trimTrailingWhitespace();
      }
      const parsed = parseMustacheInner(tagBody);

      if (parsed.type === 'comment') {
         currentBody().push({ kind: 'comment', value: String(parsed.expr.kind === 'literal' ? parsed.expr.value : '') });
      } else if (parsed.type === 'block') {
         const { name, params, hash } = exprParts(parsed.expr);
         stack.push({
            frame: 'block',
            name: typeof name === 'string' ? name : blockName(parsed.expr),
            params,
            hash,
            blockParams: parsed.blockParams ?? [],
            program: [],
            inverse: [],
            elseIfChain: [],
            openInverse: false,
            inElseIf: false,
         });
      } else if (parsed.type === 'decoratorBlock') {
         const { name, params, hash } = exprParts(parsed.expr);
         stack.push({
            frame: 'decoratorBlock',
            name: typeof name === 'string' ? name : blockName(parsed.expr),
            params,
            hash,
            program: [],
         });
      } else if (parsed.type === 'partialBlock') {
         const { name, params, hash } = exprParts(parsed.expr);
         stack.push({
            frame: 'partialBlock',
            name: typeof name === 'string' ? name : blockName(parsed.expr),
            params,
            hash,
            program: [],
         });
      } else if (parsed.type === 'inverse') {
         const top = stack[stack.length - 1];
         if (isOpenBlock(top)) {
            top.openInverse = true;
            top.inElseIf = false;
         } else {
            // Standalone inverse section: `{{^foo}}…{{/foo}}` is `{{#unless foo}}`
            // wearing a different closing tag. `closeName` keeps the close check
            // honest, because `unless` is the helper that actually renders it.
            const { name, params, hash } = exprParts(parsed.expr);
            if (parsed.expr.kind === 'path' && params.length === 0 && Object.keys(hash).length === 0) {
               // A bare path is the *subject*, not a helper call with no
               // arguments — parsing it as a path yields no params, and a
               // param-less block would test the options object instead.
               params.push(parsed.expr);
            }
            stack.push({
               frame: 'block',
               name: 'unless',
               closeName: typeof name === 'string' ? name : blockName(parsed.expr),
               params,
               hash,
               blockParams: [],
               program: [],
               inverse: [],
               elseIfChain: [],
               // The body is the *positive* program: `unless` renders it when the
               // value is falsy. Marking it inverse here would invert the sense
               // and render the body exactly when it should not.
               openInverse: false,
               inElseIf: false,
            });
         }
      } else if (parsed.type === 'else') {
         const top = stack[stack.length - 1];
         if (!isOpenBlock(top)) {
            // A stray `{{else}}` at document level. npm Handlebars treats it as
            // an unknown helper and renders it away; failing the whole parse is
            // strictly less useful, so emit nothing and move on.
            currentBody().push({ kind: 'comment', value: '' });
         } else {
            top.openInverse = true;
            if (parsed.expr.kind !== 'literal') {
               const { params, hash } = exprParts(parsed.expr);
               top.elseIfChain.push({ params, hash, program: [] });
               top.inElseIf = true;
            } else {
               top.inElseIf = false;
            }
         }
      } else if (parsed.type === 'close') {
         const closing = parsed.name ?? (parsed.expr.kind === 'path' ? parsed.expr.path : '');
         const opened = stack.pop();
         if (!opened) {
            throw new Error(`Unexpected close /${closing}`);
         }
         if (opened.frame === 'partialBlock') {
            if (opened.name !== closing) {
               throw new Error(`Partial block mismatch: expected /${opened.name} got /${closing}`);
            }
            currentBody().push({
               kind: 'partialBlock',
               name: opened.name,
               params: opened.params,
               hash: opened.hash,
               program: opened.program,
            });
         } else if (opened.frame === 'decoratorBlock') {
            if (opened.name !== closing) {
               throw new Error(`Decorator block mismatch: expected /${opened.name} got /${closing}`);
            }
            currentBody().push({
               kind: 'decoratorBlock',
               name: opened.name,
               params: opened.params,
               hash: opened.hash,
               program: opened.program,
            });
         } else if ((opened.closeName ?? opened.name) !== closing) {
            throw new Error(`Block mismatch: expected /${opened.closeName ?? opened.name} got /${closing}`);
         } else {
            let inverse = opened.inverse;
            for (let i = opened.elseIfChain.length - 1; i >= 0; i -= 1) {
               const chain = opened.elseIfChain[i]!;
               inverse = [
                  {
                     kind: 'block',
                     name: 'if',
                     params: chain.params,
                     hash: chain.hash,
                     blockParams: [],
                     program: chain.program,
                     inverse,
                  },
               ];
            }
            const block: Stmt = {
               kind: 'block',
               name: opened.name,
               params: opened.params,
               hash: opened.hash,
               blockParams: opened.blockParams,
               program: opened.program,
               inverse,
            };
            currentBody().push(block);
         }
      } else if (parsed.type === 'mustache') {
         currentBody().push({ kind: 'mustache', expr: parsed.expr, escape: !triple && !tagBody.trimStart().startsWith('&') });
      } else if (parsed.type === 'partial') {
         const { name, params, hash } = exprParts(parsed.expr);
         currentBody().push({ kind: 'partial', name, params, hash });
      }

      index = tagEnd;

      // `~` on the right of the tag eats the whitespace that follows it. Applied
      // only when the tag is a plain mustache — whitespace control on block and
      // partial delimiters needs whole-block trimming, which is deliberately out
      // of scope here rather than half-done.
      pendingLeadingTrim = parsed.type === 'mustache' && tagBody.endsWith('~');
   }

   if (stack.length > 0) {
      throw new Error(`Unclosed block: ${stack.map(s => s.name).join(', ')}`);
   }

   return statements;
};
