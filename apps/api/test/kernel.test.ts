import { describe, expect, it } from 'vitest';
import { evaluate, validateCondition, parseFormula, evalFormula } from '@gazelle/shared';
import { hotp, verifyTotp, base32Encode, base32Decode } from '../src/modules/identity/totp.js';
import { maskAccount, maskBvn, maskEmail, maskPhone } from '../src/lib/mask.js';

describe('condition language', () => {
  const facts = { facility: { amountNgn: 150_000_000, productFamily: 'MURABAHA' }, customer: { sector: 'MANUFACTURING', isPep: false } };
  it('evaluates nested all/any/not with a full trace', () => {
    const r = evaluate({ all: [{ fact: 'facility.amountNgn', op: 'gte', value: 100_000_000 }, { any: [{ fact: 'customer.sector', op: 'in', value: ['OIL_GAS', 'MANUFACTURING'] }] }, { not: { fact: 'customer.isPep', op: 'truthy' } }] }, facts);
    expect(r.result).toBe(true);
    expect(r.trace).toHaveLength(3);
  });
  it('flags missing facts as incomplete rather than silently passing', () => {
    const r = evaluate({ fact: 'customer.auditedYears', op: 'gte', value: 3 }, facts);
    expect(r.result).toBe(false);
    expect(r.incomplete).toBe(true);
    expect(r.trace[0]!.missing).toBe(true);
  });
  it('does not traverse prototype properties', () => {
    expect(evaluate({ fact: 'facility.constructor', op: 'exists' }, facts).result).toBe(false);
    expect(evaluate({ fact: '__proto__.polluted', op: 'exists' }, facts).result).toBe(false);
  });
  it('validates admin-authored conditions against the fact catalogue', () => {
    expect(validateCondition({ fact: 'facility.amountNgn', op: 'gte', value: 1 }, new Set(['facility.amountNgn']))).toEqual([]);
    expect(validateCondition({ fact: 'unknown.fact', op: 'gte', value: 1 }, new Set(['facility.amountNgn']))).toHaveLength(1);
    expect(validateCondition({ fact: 'facility.amountNgn', op: 'eval', value: 1 })).toHaveLength(1);
    expect(validateCondition({ all: [] })).toHaveLength(1);
  });
});

describe('formula engine', () => {
  it('computes ratios with precedence and functions', () => {
    const v = evalFormula(parseFormula('(CURRENT_ASSETS - INVENTORY) / CURRENT_LIABILITIES'), { CURRENT_ASSETS: 500, INVENTORY: 100, CURRENT_LIABILITIES: 200 });
    expect(v).toEqual({ ok: true, value: 2 });
    expect(evalFormula(parseFormula('-2 ^ 2 + max(1, 3) * 2'), {})).toEqual({ ok: true, value: -4 + 6 });
    expect(evalFormula(parseFormula('(REVENUE - PREV.REVENUE) / PREV.REVENUE * 100'), { REVENUE: 120, 'PREV.REVENUE': 100 })).toMatchObject({ ok: true });
  });
  it('reports division by zero and missing inputs instead of inventing values', () => {
    expect(evalFormula(parseFormula('A / B'), { A: 1, B: 0 })).toEqual({ ok: false, error: 'Division by zero' });
    expect(evalFormula(parseFormula('A / B'), { A: 1 })).toMatchObject({ ok: false, missing: ['B'] });
  });
  it('rejects code injection and malformed input', () => {
    for (const bad of ['process.exit()', 'A; B', 'require("fs")', 'A +', '(A', 'constructor.constructor("x")()', 'A ** B']) expect(() => parseFormula(bad)).toThrow();
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector for counter 1', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(hotp(secret, 1)).toBe('287082');
  });
  it('blocks replay of the same time step', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const t = Date.now();
    const step = Math.floor(t / 30000);
    const code = hotp(secret, step);
    expect(verifyTotp(secret, code, null, t)).toBe(step);
    expect(verifyTotp(secret, code, step, t)).toBeNull();
  });
});

describe('masking', () => {
  it('masks sensitive identifiers', () => {
    expect(maskAccount('0100000001')).toBe('••••••0001');
    expect(maskBvn('4321')).toBe('•••••••4321');
    expect(maskPhone('08030000001')).toBe('0803•••••01');
    expect(maskEmail('treasury@abc.demo')).toBe('t•••••••@abc.demo');
  });
});
