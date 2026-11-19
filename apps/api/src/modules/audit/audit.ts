import type { Db } from '../../db/pool.js';
import { q } from '../../db/pool.js';

export interface Actor {
  type: 'CUSTOMER' | 'STAFF' | 'SYSTEM' | 'ANONYMOUS';
  id?: string | null;
  label?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export const SYSTEM: Actor = { type: 'SYSTEM', label: 'Gazelle system' };

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  facilityId?: string | null;
  customerId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

const SENSITIVE = /(otp|code|password|secret|token|bvn|nin|pin)$/i;

/** Strip values that must never be written to logs, even the audit log. */
export function redact(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(val);
    return out;
  }
  return v;
}

export async function audit(db: Db, actor: Actor, e: AuditEntry): Promise<void> {
  await q(
    db,
    `INSERT INTO audit_log(actor_type, actor_id, actor_label, action, entity_type, entity_id, facility_id, customer_id, outcome,
       ip, user_agent, request_id, before_data, after_data, metadata, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'','')`,
    [
      actor.type,
      actor.id ?? null,
      actor.label ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.facilityId ?? null,
      e.customerId ?? null,
      e.outcome ?? 'SUCCESS',
      actor.ip ?? null,
      actor.userAgent?.slice(0, 500) ?? null,
      actor.requestId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.metadata === undefined ? null : JSON.stringify(redact(e.metadata)),
    ],
  );
}

/** Recompute the hash chain end to end. Returns the first broken link, if any. */
export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = await q<{ id: number; ok: boolean; prev_ok: boolean }>(
    db,
    `WITH c AS (
       SELECT id, prev_hash, hash, lag(hash) OVER (ORDER BY id) AS expected_prev,
         encode(digest(prev_hash || '|' || id::text || '|' || to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
           actor_type || '|' || COALESCE(actor_id::text,'') || '|' || action || '|' || entity_type || '|' ||
           COALESCE(entity_id,'') || '|' || COALESCE(facility_id::text,'') || '|' || outcome || '|' ||
           COALESCE(before_data::text,'') || '|' || COALESCE(after_data::text,'') || '|' || COALESCE(metadata::text,''), 'sha256'),'hex') AS recomputed
       FROM audit_log)
     SELECT id, (hash = recomputed) AS ok, (prev_hash = COALESCE(expected_prev,'GENESIS')) AS prev_ok FROM c ORDER BY id`,
  );
  const bad = rows.find((r) => !r.ok || !r.prev_ok);
  return { ok: !bad, checked: rows.length, brokenAt: bad?.id };
}
