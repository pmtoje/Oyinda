import { evaluate } from '@gazelle/shared';

export interface Level {
  code: string; name: string; kind: 'INDIVIDUAL' | 'COMMITTEE'; role?: string; committeeKey?: string;
  limitMinor: number; cashBackedLimitMinor?: number; slaPolicyKey: string;
  participatesAboveMinor?: number; canBeFinal?: boolean; overrideOnly?: boolean;
}

/**
 * Determine the approval chain for an amount (NGN minor units) under an authority matrix.
 * Pure and deterministic.
 *
 * - A level takes part only when the amount exceeds its `participatesAboveMinor` (combination /
 *   concurrence approvals, e.g. "ED + CRO + HCR up to ₦150m": the CRO joins only above ₦100m).
 * - The final level is the first participating level that may be final and whose limit covers the amount.
 * - Overrides raise the final level; `fullChain` overrides bring every level up to the final one into the chain.
 */
export function resolveChain(authority: { levels: Level[]; overrides: any[] }, facts: Record<string, any>, amountNgnMinor: number) {
  const levels = authority.levels;
  const reasons: string[] = [];
  const cashBacked = !!facts.facility?.isCashBacked;
  const limitOf = (l: Level) => (cashBacked && l.cashBackedLimitMinor ? l.cashBackedLimitMinor : l.limitMinor);
  const participates = (l: Level) => !l.overrideOnly && amountNgnMinor > (l.participatesAboveMinor ?? -1);
  let finalIdx = levels.findIndex((l) => participates(l) && l.canBeFinal !== false && limitOf(l) >= amountNgnMinor);
  if (finalIdx < 0) {
    finalIdx = levels.length - 1;
    while (finalIdx > 0 && (levels[finalIdx]!.overrideOnly || levels[finalIdx]!.canBeFinal === false)) finalIdx--;
  }
  reasons.push(`Amount within the authority of ${levels[finalIdx]!.name}${cashBacked && levels.some((l) => l.cashBackedLimitMinor) ? ' (cash-backed limits applied)' : ''}.`);
  let fullChain = false;
  for (const o of authority.overrides ?? []) {
    if (!evaluate(o.when, facts).result) continue;
    const target = o.finalLevel ?? o.minimumFinalLevel;
    const idx = levels.findIndex((l) => l.code === target);
    if (idx < 0) continue;
    if (o.finalLevel) { finalIdx = Math.max(finalIdx, idx); reasons.push(`${o.code}: ${o.reason}`); if (o.fullChain) fullChain = true; }
    else if (idx > finalIdx) { finalIdx = idx; reasons.push(`${o.code}: ${o.reason}`); if (o.fullChain) fullChain = true; }
  }
  const chain = levels
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i <= finalIdx && (i === finalIdx || fullChain || participates(l)))
    .map(({ l, i }) => ({ ...l, effectiveLimitMinor: limitOf(l), isFinal: i === finalIdx }));
  return { chain, finalLevel: levels[finalIdx]!, reasons, cashBacked, fullChain };
}

export interface CommitteeRules { quorum: number; requiredApprovals: number; requiredRoles: string[]; requiredRoleCounts?: Record<string, number>; voting: 'PARALLEL' | 'SERIAL'; serialOrder: string[] }
export interface Vote { member_id: string; member_role: string; vote: 'APPROVE' | 'DECLINE' | 'ABSTAIN' | 'RETURN' }

/**
 * Committee decision rule (pure). `requiredRoleCounts` keys may list alternatives separated by "|"
 * (e.g. "ED|MD": 2 means two approving signatures from Executive Directors, the MD counting as one).
 */
export function committeeDecision(rules: CommitteeRules, members: { id: string; roles: string[] }[], votes: Vote[]): 'APPROVED' | 'DECLINED' | 'PENDING' {
  const approvals = votes.filter((v) => v.vote === 'APPROVE');
  const cast = votes.length;
  const rolesOf = (id: string, fallback?: string) => members.find((m) => m.id === id)?.roles ?? (fallback ? [fallback] : []);
  const holds = (id: string, key: string, fallback?: string) => key.split('|').some((r) => rolesOf(id, fallback).includes(r));
  const roleOk = (role: string) => approvals.some((v) => v.member_role === role || rolesOf(v.member_id).includes(role));
  const counts = Object.entries(rules.requiredRoleCounts ?? {});
  const countOk = (key: string, n: number) => approvals.filter((v) => holds(v.member_id, key, v.member_role)).length >= n;
  const rolesSatisfied = rules.requiredRoles.every(roleOk) && counts.every(([k, n]) => countOk(k, n));
  if (cast >= rules.quorum && approvals.length >= rules.requiredApprovals && rolesSatisfied) return 'APPROVED';
  const remaining = members.filter((m) => !votes.some((v) => v.member_id === m.id));
  const maxApprovals = approvals.length + remaining.length;
  const roleStillPossible = rules.requiredRoles.every((r) => roleOk(r) || remaining.some((m) => m.roles.includes(r)));
  const countsStillPossible = counts.every(([k, n]) => approvals.filter((v) => holds(v.member_id, k, v.member_role)).length + remaining.filter((m) => holds(m.id, k)).length >= n);
  if (maxApprovals < rules.requiredApprovals || !roleStillPossible || !countsStillPossible || cast + remaining.length < rules.quorum) return 'DECLINED';
  return 'PENDING';
}
