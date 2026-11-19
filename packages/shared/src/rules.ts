/**
 * Gazelle condition language. Used by FIPG eligibility, E&S triggers, workflow routing,
 * special workflows, cash-backed classification and document requirements.
 * Pure data (JSON), evaluated without eval(); every evaluation returns an explanation trace.
 */
export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'exists' | 'between' | 'truthy' | 'falsy';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { always: true }
  | { fact: string; op: Op; value?: unknown; label?: string };

export interface TraceLine {
  fact: string;
  label?: string;
  op: Op;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  missing: boolean;
}

export interface EvalResult {
  result: boolean;
  /** true when the outcome depended on a fact that was not supplied */
  incomplete: boolean;
  trace: TraceLine[];
}

export const OPS: readonly Op[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'exists', 'between', 'truthy', 'falsy'];

export function getFact(facts: Record<string, unknown>, path: string): unknown {
  let cur: unknown = facts;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (v instanceof Date) return v.getTime();
  return undefined;
};

function compare(op: Op, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'eq':
      return actual === expected || (num(actual) !== undefined && num(actual) === num(expected));
    case 'ne':
      return !(actual === expected || (num(actual) !== undefined && num(actual) === num(expected)));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = num(actual);
      const e = num(expected);
      if (a === undefined || e === undefined) return false;
      return op === 'gt' ? a > e : op === 'gte' ? a >= e : op === 'lt' ? a < e : a <= e;
    }
    case 'between': {
      const a = num(actual);
      if (!Array.isArray(expected) || expected.length !== 2 || a === undefined) return false;
      const [lo, hi] = expected.map(num);
      return lo !== undefined && hi !== undefined && a >= lo && a <= hi;
    }
    case 'in':
      return Array.isArray(expected) && expected.some((x) => x === actual);
    case 'nin':
      return Array.isArray(expected) && !expected.some((x) => x === actual);
    case 'contains':
      return Array.isArray(actual) ? actual.includes(expected) : typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
  }
}

export function evaluate(cond: Condition, facts: Record<string, unknown>): EvalResult {
  const trace: TraceLine[] = [];
  let incomplete = false;
  const walk = (c: Condition): boolean => {
    if ('always' in c) return true;
    if ('all' in c) return c.all.map(walk).every(Boolean); // evaluate all branches so the trace is complete
    if ('any' in c) return c.any.map(walk).some(Boolean);
    if ('not' in c) return !walk(c.not);
    const actual = getFact(facts, c.fact);
    const missing = actual === undefined && c.op !== 'exists' && c.op !== 'falsy';
    if (missing) incomplete = true;
    const passed = !missing && compare(c.op, actual, c.value);
    trace.push({ fact: c.fact, label: c.label, op: c.op, expected: c.value, actual, passed, missing });
    return passed;
  };
  const result = walk(cond);
  return { result, incomplete, trace };
}

/** Structural validation for admin-authored conditions. Returns a list of problems. */
export function validateCondition(c: unknown, allowedFacts?: ReadonlySet<string>, path = '$'): string[] {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [`${path}: condition must be an object`];
  const o = c as Record<string, unknown>;
  const keys = Object.keys(o);
  if ('always' in o) return o.always === true && keys.length === 1 ? [] : [`${path}: 'always' must be exactly { always: true }`];
  for (const k of ['all', 'any'] as const) {
    if (k in o) {
      if (!Array.isArray(o[k]) || (o[k] as unknown[]).length === 0) return [`${path}.${k}: must be a non-empty array`];
      return (o[k] as unknown[]).flatMap((x, i) => validateCondition(x, allowedFacts, `${path}.${k}[${i}]`));
    }
  }
  if ('not' in o) return validateCondition(o.not, allowedFacts, `${path}.not`);
  const errs: string[] = [];
  if (typeof o.fact !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(o.fact)) errs.push(`${path}.fact: invalid fact name`);
  else if (allowedFacts && !allowedFacts.has(o.fact)) errs.push(`${path}.fact: unknown fact '${o.fact}'`);
  if (!OPS.includes(o.op as Op)) errs.push(`${path}.op: unsupported operator`);
  if ((o.op === 'in' || o.op === 'nin') && !Array.isArray(o.value)) errs.push(`${path}.value: must be an array for ${o.op}`);
  if (o.op === 'between' && !(Array.isArray(o.value) && o.value.length === 2)) errs.push(`${path}.value: must be [min, max]`);
  return errs;
}

const OP_TEXT: Record<Op, string> = {
  eq: 'equals', ne: 'does not equal', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most',
  in: 'one of', nin: 'not one of', contains: 'contains', exists: 'is provided', between: 'between', truthy: 'is true', falsy: 'is false',
};
export const describeOp = (op: Op) => OP_TEXT[op];
