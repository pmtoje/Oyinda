/**
 * Safe arithmetic formula engine for configurable financial ratios.
 * Grammar: expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ;
 *          unary := '-' unary | power ; power := primary ('^' unary)? ;
 *          primary := number | IDENT | IDENT '(' args ')' | '(' expr ')'
 * Identifiers are line-item codes (UPPER_SNAKE) or PREV.CODE for the prior period.
 */
export type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Node; r: Node }
  | { t: 'neg'; e: Node }
  | { t: 'call'; fn: string; args: Node[] };

const FUNCS: Record<string, (args: number[]) => number> = {
  abs: ([a]) => Math.abs(a!),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  avg: (a) => a.reduce((s, x) => s + x, 0) / a.length,
};

export class FormulaError extends Error {}

type Tok = { k: 'num' | 'id' | 'op' | 'lp' | 'rp' | 'comma'; v: string };

function tokenize(src: string): Tok[] {
  if (src.length > 500) throw new FormulaError('Formula too long');
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`Invalid number at ${i}`);
      out.push({ k: 'num', v: m[0] }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/^'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    if (ch === '(') { out.push({ k: 'lp', v: ch }); i++; continue; }
    if (ch === ')') { out.push({ k: 'rp', v: ch }); i++; continue; }
    if (ch === ',') { out.push({ k: 'comma', v: ch }); i++; continue; }
    throw new FormulaError(`Unexpected character '${ch}' at ${i}`);
  }
  return out;
}

export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const expect = (k: Tok['k']) => {
    const t = toks[p++];
    if (!t || t.k !== k) throw new FormulaError(`Expected ${k}`);
    return t;
  };
  const expr = (): Node => {
    if (++depth > 50) throw new FormulaError('Formula nested too deeply');
    let l = term();
    while (peek()?.k === 'op' && (peek()!.v === '+' || peek()!.v === '-')) {
      const op = toks[p++]!.v as '+' | '-';
      l = { t: 'bin', op, l, r: term() };
    }
    depth--;
    return l;
  };
  const term = (): Node => {
    let l = unary();
    while (peek()?.k === 'op' && (peek()!.v === '*' || peek()!.v === '/')) {
      const op = toks[p++]!.v as '*' | '/';
      l = { t: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Node => {
    if (peek()?.k === 'op' && peek()!.v === '-') { p++; return { t: 'neg', e: unary() }; }
    return power();
  };
  const power = (): Node => {
    const base = primary();
    if (peek()?.k === 'op' && peek()!.v === '^') { p++; return { t: 'bin', op: '^', l: base, r: unary() }; }
    return base;
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new FormulaError('Unexpected end of formula');
    if (t.k === 'num') return { t: 'num', v: Number(t.v) };
    if (t.k === 'lp') { const e = expr(); expect('rp'); return e; }
    if (t.k === 'id') {
      if (peek()?.k === 'lp') {
        const fn = t.v.toLowerCase();
        if (!FUNCS[fn]) throw new FormulaError(`Unknown function ${t.v}`);
        p++;
        const args: Node[] = [];
        if (peek()?.k !== 'rp') {
          args.push(expr());
          while (peek()?.k === 'comma') { p++; args.push(expr()); }
        }
        expect('rp');
        if (args.length === 0) throw new FormulaError(`${fn} needs at least one argument`);
        return { t: 'call', fn, args };
      }
      return { t: 'var', name: t.v };
    }
    throw new FormulaError(`Unexpected token '${t.v}'`);
  };
  const ast = expr();
  if (p !== toks.length) throw new FormulaError(`Unexpected token '${toks[p]!.v}'`);
  return ast;
}

export function variablesOf(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === 'var') out.add(n.name);
  else if (n.t === 'bin') { variablesOf(n.l, out); variablesOf(n.r, out); }
  else if (n.t === 'neg') variablesOf(n.e, out);
  else if (n.t === 'call') n.args.forEach((a) => variablesOf(a, out));
  return out;
}

export type FormulaOutcome = { ok: true; value: number } | { ok: false; error: string; missing?: string[] };

export function evalFormula(n: Node, vars: Record<string, number | undefined>): FormulaOutcome {
  const missing = [...variablesOf(n)].filter((v) => vars[v] === undefined || vars[v] === null);
  if (missing.length) return { ok: false, error: 'Missing inputs', missing };
  const go = (x: Node): number => {
    switch (x.t) {
      case 'num': return x.v;
      case 'var': return vars[x.name]!;
      case 'neg': return -go(x.e);
      case 'call': return FUNCS[x.fn]!(x.args.map(go));
      case 'bin': {
        const l = go(x.l); const r = go(x.r);
        if (x.op === '/' && r === 0) throw new FormulaError('Division by zero');
        return x.op === '+' ? l + r : x.op === '-' ? l - r : x.op === '*' ? l * r : x.op === '/' ? l / r : Math.pow(l, r);
      }
    }
  };
  try {
    const v = go(n);
    return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, error: 'Result is not a finite number' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
