import type { Db } from '../../db/pool.js';
import { q, maybe, one } from '../../db/pool.js';
import { audit, type Actor } from '../audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { schemas, type ConfigKind, type Payload } from './schemas.js';

export interface ConfigRow<P = unknown> {
  id: string;
  kind: ConfigKind;
  key: string;
  version: number;
  status: string;
  title: string;
  payload: P;
  effective_from: string | null;
  effective_to: string | null;
  change_reason: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

const APPROVED = `status IN ('ACTIVE','RETIRED') AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)`;

export function validatePayload<K extends ConfigKind>(kind: K, payload: unknown): Payload<K> {
  const schema = schemas[kind];
  if (!schema) throw badRequest('CONFIG_KIND', `Unknown configuration kind ${kind}`);
  const r = schema.safeParse(payload);
  if (!r.success) throw badRequest('CONFIG_INVALID', 'Configuration payload is invalid.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data as Payload<K>;
}

/** The version of `key` in force at `at`. */
export async function getActive<K extends ConfigKind>(db: Db, kind: K, key: string, at: Date = new Date()): Promise<ConfigRow<Payload<K>> | undefined> {
  return maybe(db, `SELECT * FROM config_item WHERE kind=$1 AND key=$2 AND ${APPROVED} ORDER BY version DESC LIMIT 1`, [kind, key, at]);
}

export async function requireActive<K extends ConfigKind>(db: Db, kind: K, key: string, at?: Date): Promise<ConfigRow<Payload<K>>> {
  const r = await getActive(db, kind, key, at);
  if (!r) throw conflict('CONFIG_MISSING', `No active ${kind} configuration '${key}'. An administrator must configure it.`);
  return r;
}

export async function listActive<K extends ConfigKind>(db: Db, kind: K, at: Date = new Date()): Promise<ConfigRow<Payload<K>>[]> {
  return q(db, `SELECT DISTINCT ON (key) * FROM config_item WHERE kind=$1 AND $2::text IS NULL AND ${APPROVED} ORDER BY key, version DESC`, [kind, null, at]);
}

export async function getById<P = unknown>(db: Db, id: string): Promise<ConfigRow<P>> {
  const r = await maybe<ConfigRow<P>>(db, 'SELECT * FROM config_item WHERE id=$1', [id]);
  if (!r) throw notFound('Configuration');
  return r;
}

export async function createDraft(db: Db, actor: Actor, input: { kind: ConfigKind; key: string; title: string; payload: unknown; changeReason: string; effectiveFrom?: string }) {
  const payload = validatePayload(input.kind, input.payload);
  if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(input.key)) throw badRequest('CONFIG_KEY', 'Key may contain letters, digits, _ . : - only.');
  const next = await one<{ v: number }>(db, 'SELECT COALESCE(MAX(version),0)+1 AS v FROM config_item WHERE kind=$1 AND key=$2', [input.kind, input.key]);
  const pending = await maybe(db, `SELECT id FROM config_item WHERE kind=$1 AND key=$2 AND status IN ('DRAFT','PENDING_APPROVAL')`, [input.kind, input.key]);
  if (pending) throw conflict('CONFIG_PENDING', 'A draft or pending change already exists for this item. Complete or reject it first.');
  const row = await one<ConfigRow>(
    db,
    `INSERT INTO config_item(kind,key,version,status,title,payload,effective_from,change_reason,created_by)
     VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8) RETURNING *`,
    [input.kind, input.key, next.v, input.title, JSON.stringify(payload), input.effectiveFrom ?? null, input.changeReason, actor.id ?? null],
  );
  await audit(db, actor, { action: 'CONFIG_DRAFT_CREATED', entityType: 'config_item', entityId: row.id, after: { kind: row.kind, key: row.key, version: row.version, payload } });
  return row;
}

export async function submitDraft(db: Db, actor: Actor, id: string) {
  const row = await getById(db, id);
  if (row.status !== 'DRAFT') throw conflict('CONFIG_STATE', 'Only drafts can be submitted for approval.');
  if (row.created_by !== actor.id) throw forbidden('Only the maker can submit this draft.');
  const updated = await one<ConfigRow>(db, `UPDATE config_item SET status='PENDING_APPROVAL', submitted_at=now() WHERE id=$1 RETURNING *`, [id]);
  await audit(db, actor, { action: 'CONFIG_SUBMITTED', entityType: 'config_item', entityId: id, metadata: { kind: row.kind, key: row.key, version: row.version } });
  return updated;
}

/** Checker approval. The approver must differ from the maker (also enforced by a DB constraint). */
export async function approve(db: Db, actor: Actor, id: string, opts: { system?: boolean } = {}) {
  const row = await maybe<ConfigRow>(db, 'SELECT * FROM config_item WHERE id=$1 FOR UPDATE', [id]);
  if (!row) throw notFound('Configuration');
  if (row.status !== 'PENDING_APPROVAL' && !(opts.system && row.status === 'DRAFT')) throw conflict('CONFIG_STATE', 'Only changes pending approval can be approved.');
  if (!opts.system && row.created_by && row.created_by === actor.id) throw forbidden('Maker-checker: you cannot approve your own change.');
  const effectiveFrom = row.effective_from && new Date(row.effective_from) > new Date() ? new Date(row.effective_from) : new Date();
  // Close the version currently open-ended, from the moment the new one takes effect.
  const prev = await maybe<ConfigRow>(db, `SELECT * FROM config_item WHERE kind=$1 AND key=$2 AND status='ACTIVE' AND effective_to IS NULL FOR UPDATE`, [row.kind, row.key]);
  if (prev) await q(db, `UPDATE config_item SET status='RETIRED', effective_to=$2, deactivated_at=$2 WHERE id=$1`, [prev.id, effectiveFrom]);
  const updated = await one<ConfigRow>(
    db,
    `UPDATE config_item SET status='ACTIVE', approved_by=$2, approved_at=now(), effective_from=$3, activated_at=$3 WHERE id=$1 RETURNING *`,
    [id, opts.system ? null : actor.id, effectiveFrom],
  );
  await audit(db, actor, { action: 'CONFIG_APPROVED', entityType: 'config_item', entityId: id, before: prev ? { id: prev.id, version: prev.version } : undefined, metadata: { kind: row.kind, key: row.key, version: row.version, effectiveFrom } });
  return updated;
}

export async function reject(db: Db, actor: Actor, id: string, reason: string) {
  const row = await getById(db, id);
  if (row.status !== 'PENDING_APPROVAL') throw conflict('CONFIG_STATE', 'Only pending changes can be rejected.');
  if (row.created_by === actor.id) throw forbidden('Maker-checker: you cannot reject your own change; withdraw it instead.');
  const updated = await one<ConfigRow>(db, `UPDATE config_item SET status='REJECTED', rejected_reason=$2 WHERE id=$1 RETURNING *`, [id, reason]);
  await audit(db, actor, { action: 'CONFIG_REJECTED', entityType: 'config_item', entityId: id, metadata: { reason } });
  return updated;
}

export async function deactivate(db: Db, actor: Actor, id: string, reason: string) {
  const row = await getById(db, id);
  if (row.status !== 'ACTIVE') throw conflict('CONFIG_STATE', 'Only active configuration can be deactivated.');
  const updated = await one<ConfigRow>(db, `UPDATE config_item SET status='RETIRED', effective_to=now(), deactivated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await audit(db, actor, { action: 'CONFIG_DEACTIVATED', entityType: 'config_item', entityId: id, metadata: { reason } });
  return updated;
}

/** Seed helper: create and activate in one step as SYSTEM (bootstrap only). */
export async function bootstrap(db: Db, actor: Actor, kind: ConfigKind, key: string, title: string, payload: unknown) {
  const existing = await getActive(db, kind, key);
  if (existing) return existing;
  const d = await createDraft(db, actor, { kind, key, title, payload, changeReason: 'Initial baseline configuration (bootstrap)' });
  return approve(db, actor, d.id, { system: true });
}
