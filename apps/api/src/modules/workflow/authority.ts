import { evaluate } from '@gazelle/shared';

export interface Level { code: string; name: string; kind: 'INDIVIDUAL' | 'COMMITTEE'; role?: string; committeeKey?: string; limitMinor: number; cashBackedLimitMinor?: number; slaPolicyKey: string }

/**
 * Determine the approval chain for an amount (NGN minor units) under the authority matrix.
 * Pure and deterministic: returns the levels to traverse, the final approving level and why.
 */
export function resolveChain(authority: { levels: Level[]; overrides: any[] }, facts: Record<string, any>, amountNgnMinor: number) {
  const levels = authority.levels;
  const reasons: string[] = [];
  const cashBacked = !!facts.facility?.isCashBacked;
  const limitOf = (l: Level) => (cashBacked && l.cashBackedLimitMinor ? l.cashBackedLimitMinor : l.limitMinor);
  let finalIdx = levels.findIndex((l) => limitOf(l) >= amountNgnMinor);
  if (finalIdx < 0) finalIdx = levels.length - 1;
  reasons.push(`Amount within the authority of ${levels[finalIdx]!.name}${cashBacked ? ' (cash-backed limits applied)' : ''}.`);
  for (const o of authority.overrides ?? []) {
    if (!evaluate(o.when, facts).result) continue;
    const target = o.finalLevel ?? o.minimumFinalLevel;
    const idx = levels.findIndex((l) => l.code === target);
    if (idx < 0) continue;
    if (o.finalLevel) { finalIdx = Math.max(finalIdx, idx); reasons.push(`${o.code}: ${o.reason}`); }
    else if (idx > finalIdx) { finalIdx = idx; reasons.push(`${o.code}: ${o.reason}`); }
  }
  return { chain: levels.slice(0, finalIdx + 1).map((l, i) => ({ ...l, effectiveLimitMinor: limitOf(l), isFinal: i === finalIdx })), finalLevel: levels[finalIdx]!, reasons, cashBacked };
}

export interface CommitteeRules { quorum: number; requiredApprovals: number; requiredRoles: string[]; voting: 'PARALLEL' | 'SERIAL'; serialOrder: string[] }
export interface Vote { member_id: string; member_role: string; vote: 'APPROVE' | 'DECLINE' | 'ABSTAIN' | 'RETURN' }

/** Committee decision rule (pure). */
export function committeeDecision(rules: CommitteeRules, members: { id: string; roles: string[] }[], votes: Vote[]): 'APPROVED' | 'DECLINED' | 'PENDING' {
  const approvals = votes.filter((v) => v.vote === 'APPROVE');
  const cast = votes.length;
  const roleOk = (role: string) => approvals.some((v) => v.member_role === role);
  const rolesSatisfied = rules.requiredRoles.every(roleOk);
  if (cast >= rules.quorum && approvals.length >= rules.requiredApprovals && rolesSatisfied) return 'APPROVED';
  const remaining = members.filter((m) => !votes.some((v) => v.member_id === m.id));
  const maxApprovals = approvals.length + remaining.length;
  const roleStillPossible = rules.requiredRoles.every((r) => roleOk(r) || remaining.some((m) => m.roles.includes(r)));
  if (maxApprovals < rules.requiredApprovals || !roleStillPossible || cast + remaining.length < rules.quorum) return 'DECLINED';
  return 'PENDING';
}
