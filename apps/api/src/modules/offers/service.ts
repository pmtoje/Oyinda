import { evaluate } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { audit, type Actor } from '../audit/audit.js';
import { getById, listActive } from '../config/service.js';
import { buildFacts, collateralSummary } from '../facilities/facts.js';
import { formatMoney } from '../../lib/money.js';

/** Build security summary text from recorded collateral. */
export async function securityText(db: Db, facilityId: string, amountMinor: number, ccy: string) {
  const col = await collateralSummary(db, facilityId, amountMinor, ccy);
  const types = new Map((await listActive(db, 'collateral_type')).map((t) => [t.key, t.payload.name]));
  if (!col.items.length) return 'No security recorded.';
  return col.items.map((c: any) => `${types.get(c.type_key) ?? c.type_key}: ${c.description} — market value ${formatMoney(c.market_value_minor, c.currency)}, eligible value ${formatMoney(c.eligible_value_ngn_minor)} (${c.perfection_status.replace(/_/g, ' ').toLowerCase()})`).join('\n') + `\nEligible cover: ${col.coveragePct}% of the facility amount.`;
}

/**
 * Called inside the approval transaction. Freezes the approved terms (immutable, version 1+) and generates
 * the conditions checklist from configured condition templates plus approver/E&S conditions.
 */
export async function onCreditApproved(db: Db, facilityId: string, actor: Actor) {
  const f = await one<any>(db, 'SELECT * FROM facility_request WHERE id=$1', [facilityId]);
  const product = await getById<any>(db, f.product_config_id);
  const rar = await maybe<any>(db, `SELECT * FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const finalAction = await maybe<any>(db, `SELECT * FROM workflow_action WHERE facility_id=$1 AND action='APPROVE' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const approvers = await q<{ actor_name: string }>(db, `SELECT DISTINCT ON (actor_name) actor_name FROM workflow_action WHERE facility_id=$1 AND action IN ('APPROVE','RECOMMEND','VOTE') AND actor_type='STAFF'`, [facilityId]);
  const approverConditions = (await q<{ payload: any }>(db, `SELECT payload FROM workflow_action WHERE facility_id=$1 AND payload ? 'conditions' AND payload->'conditions' IS NOT NULL AND jsonb_typeof(payload->'conditions')='array'`, [facilityId])).flatMap((r) => r.payload.conditions as string[]);
  const es = await maybe<any>(db, `SELECT conditions FROM es_assessment WHERE facility_id=$1 AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [facilityId]);
  const { facts } = await buildFacts(db, facilityId);
  const templates = (await listActive(db, 'condition_template')).filter((t) => evaluate(t.payload.appliesWhen as any, facts).result);
  const items = templates.flatMap((t) => t.payload.items);
  approverConditions.forEach((c, i) => items.push({ code: `APPROVAL_COND_${i + 1}`, description: c, category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true }));
  (es?.conditions ?? []).forEach((c: string, i: number) => items.push({ code: `ES_COND_${i + 1}`, description: c, category: 'SUBSEQUENT', ownerTeam: 'CREDIT_OPS', mandatory: true }));
  const n = await one<{ n: number }>(db, 'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM approved_terms WHERE facility_id=$1', [facilityId]);
  const rate = rar?.request?.proposedProfitRatePct ?? product.payload.indicativeProfitRatePct ?? 0;
  const terms = await one<any>(db, `INSERT INTO approved_terms(facility_id, version_no, source, source_action_id, product_code, currency, amount_minor, tenor_months, profit_rate_pct, management_fee_pct, payment_frequency, moratorium_months, security_summary, conditions, approved_by_names)
     VALUES ($1,$2,'CREDIT_APPROVAL',$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13) RETURNING *`,
    [facilityId, n.n, finalAction?.id ?? null, f.product_code, f.currency, f.amount_minor, f.tenor_months, rate, rar?.request?.managementFeePct ?? 1, f.payment_frequency, await securityText(db, facilityId, f.amount_minor, f.currency), JSON.stringify(items), approvers.map((a) => a.actor_name)]);
  for (const it of items) {
    await q(db, `INSERT INTO condition_item(facility_id, terms_id, code, description, category, owner_team, mandatory, frequency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [facilityId, terms.id, it.code, it.description, it.category, it.ownerTeam, it.mandatory, it.frequency ?? null]);
  }
  await audit(db, actor, { action: 'TERMS_APPROVED', entityType: 'approved_terms', entityId: terms.id, facilityId, after: { version: terms.version_no, amountMinor: terms.amount_minor, tenor: terms.tenor_months, rate: terms.profit_rate_pct, conditions: items.length } });
  return terms;
}
