import { evaluate } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { sha256Hex } from '../../lib/crypto.js';
import { badRequest, unprocessable } from '../../lib/errors.js';
import { integrations } from '../../integrations/index.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { getPool } from '../../db/pool.js';
import { audit, SYSTEM, type Actor } from '../audit/audit.js';
import { listActive } from '../config/service.js';
import { buildFacts } from '../facilities/facts.js';
import { checkFile, MIME } from './mime.js';
import { deleteObject, putObject } from './storage.js';

export const ALL_MIME = Object.values(MIME);

/** Generate / refresh the document checklist from configuration and current facts. */
export async function syncRequirements(db: Db, facilityId: string, stage: 'APPLICATION' | 'FULFILMENT' = 'APPLICATION') {
  const { facts, facility } = await buildFacts(db, facilityId);
  const reqs = (await listActive(db, 'document_requirement')).filter((r) => r.payload.stage === stage);
  const existing = await q<any>(db, 'SELECT * FROM document WHERE facility_id=$1 AND deleted_at IS NULL AND requirement_key IS NOT NULL', [facilityId]);
  const applicable = new Set<string>();
  for (const r of reqs) {
    if (!evaluate(r.payload.appliesWhen as any, facts).result) continue;
    applicable.add(r.key);
    if (existing.some((d) => d.requirement_key === r.key)) continue;
    // Reuse a verified, unexpired document of the same type the customer already provided.
    const reusable = !r.payload.reusable ? undefined : await maybe<any>(db, `SELECT d.* FROM document d WHERE d.customer_id=$1 AND d.doc_type=$2 AND d.status='VERIFIED' AND d.deleted_at IS NULL
      AND (d.expiry_date IS NULL OR d.expiry_date > current_date) ORDER BY d.reviewed_at DESC LIMIT 1`, [facility.customer_id, r.payload.docType]);
    const doc = await one<any>(db, `INSERT INTO document(customer_id, facility_id, requirement_key, doc_type, title, status, mandatory, customer_visible, current_version_id, expiry_date, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [facility.customer_id, facilityId, r.key, r.payload.docType, r.payload.title, reusable ? 'VERIFIED' : 'REQUIRED', r.payload.mandatory, r.payload.customerVisible, reusable?.current_version_id ?? null, reusable?.expiry_date ?? null, reusable?.reviewed_by ?? null, reusable?.reviewed_at ?? null]);
    await q(db, `INSERT INTO document_event(document_id, version_id, event, actor_type, note) VALUES ($1,$2,$3,'SYSTEM',$4)`, [doc.id, reusable?.current_version_id ?? null, reusable ? 'REUSED' : 'REQUIRED', reusable ? `Reused verified document from an earlier request` : null]);
  }
  // Requirements that no longer apply (e.g. amount reduced) and were never fulfilled are withdrawn.
  for (const d of existing) {
    if (!applicable.has(d.requirement_key) && d.status === 'REQUIRED' && reqs.some((r) => r.key === d.requirement_key)) {
      await q(db, 'UPDATE document SET deleted_at=now() WHERE id=$1', [d.id]);
    }
  }
}

export async function requirementFor(db: Db, doc: { requirement_key: string | null }) {
  if (!doc.requirement_key) return { acceptedMime: ALL_MIME, maxSizeMb: 20, validityDays: undefined as number | undefined };
  const r = (await listActive(db, 'document_requirement')).find((x) => x.key === doc.requirement_key);
  return { acceptedMime: r?.payload.acceptedMime ?? ALL_MIME, maxSizeMb: r?.payload.maxSizeMb ?? 20, validityDays: r?.payload.validityDays };
}

/** Validate, scan, encrypt and store a new immutable version of a document. */
export async function storeVersion(db: Db, actor: Actor, input: { documentId: string; buffer: Buffer; filename: string; declaredMime?: string; acceptedMime: readonly string[]; maxSizeMb: number; metadata?: Record<string, unknown>; facilityId?: string | null; customerId: string }) {
  const check = checkFile(input.buffer, input.filename, input.acceptedMime, input.maxSizeMb * 1024 * 1024);
  if (!check.ok) {
    await audit(db, actor, { action: 'DOCUMENT_UPLOAD_REJECTED', entityType: 'document', entityId: input.documentId, facilityId: input.facilityId, customerId: input.customerId, outcome: 'FAILURE', metadata: { reason: check.reason, filename: input.filename.slice(0, 100) } });
    throw unprocessable('FILE_REJECTED', check.reason!);
  }
  const sha = sha256Hex(input.buffer);
  const scan = await integrations().antivirus.scan(input.buffer);
  if (scan.status === 'INFECTED') {
    await audit(db, actor, { action: 'MALWARE_DETECTED', entityType: 'document', entityId: input.documentId, facilityId: input.facilityId, customerId: input.customerId, outcome: 'DENIED', metadata: { engine: scan.engine, signature: scan.signature, sha256: sha } });
    throw unprocessable('MALWARE_DETECTED', 'This file failed the security scan and was not accepted.');
  }
  const stored = await putObject(input.buffer);
  const n = await one<{ n: number }>(db, 'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM document_version WHERE document_id=$1', [input.documentId]);
  const v = await one<any>(db, `INSERT INTO document_version(document_id, version_no, original_filename, storage_key, size_bytes, sha256, declared_mime, detected_mime, enc_wrapped_key, enc_iv, enc_tag, enc_key_id, scan_status, scan_engine, scanned_at, metadata, uploaded_by_type, uploaded_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [input.documentId, n.n, input.filename, stored.storageKey, input.buffer.length, sha, input.declaredMime ?? null, check.mime, stored.wrappedKey, stored.iv, stored.tag, stored.keyId, scan.status === 'CLEAN' ? 'CLEAN' : 'PENDING', scan.engine, scan.status === 'CLEAN' ? new Date() : null, JSON.stringify(input.metadata ?? {}), actor.type, actor.id]);
  if (scan.status === 'ERROR') await enqueue(db, 'document.rescan', { versionId: v.id }, { idempotencyKey: `rescan:${v.id}` });
  const dup = await maybe<{ id: string }>(db, `SELECT dv.id FROM document_version dv JOIN document d ON d.id=dv.document_id WHERE dv.sha256=$1 AND d.customer_id=$2 AND dv.id<>$3 LIMIT 1`, [sha, input.customerId, v.id]);
  await q(db, `INSERT INTO document_event(document_id, version_id, event, actor_type, actor_id, note) VALUES ($1,$2,'UPLOADED',$3,$4,$5)`, [input.documentId, v.id, actor.type, actor.id, dup ? 'Identical file previously uploaded by this customer' : null]);
  await audit(db, actor, { action: 'DOCUMENT_UPLOADED', entityType: 'document', entityId: input.documentId, facilityId: input.facilityId, customerId: input.customerId, metadata: { versionId: v.id, version: v.version_no, sha256: sha, size: v.size_bytes, mime: check.mime, scan: scan.status, engine: scan.engine, duplicateOf: dup?.id } });
  return { version: v, duplicate: !!dup };
}

export async function uploadToDocument(db: Db, actor: Actor, doc: any, file: { buffer: Buffer; filename: string; mimetype?: string }, metadata?: Record<string, unknown>) {
  if (doc.status === 'VERIFIED' && actor.type === 'CUSTOMER') throw badRequest('VERIFIED', 'This document has been verified. Contact your relationship manager to replace it.');
  const r = await requirementFor(db, doc);
  const { version, duplicate } = await storeVersion(db, actor, { documentId: doc.id, buffer: file.buffer, filename: file.filename, declaredMime: file.mimetype, acceptedMime: r.acceptedMime, maxSizeMb: r.maxSizeMb, metadata, facilityId: doc.facility_id, customerId: doc.customer_id });
  if (doc.current_version_id) await q(db, `INSERT INTO document_event(document_id, version_id, event, actor_type, actor_id) VALUES ($1,$2,'SUPERSEDED',$3,$4)`, [doc.id, doc.current_version_id, actor.type, actor.id]);
  const expiry = r.validityDays ? new Date(Date.now() + r.validityDays * 86400_000).toISOString().slice(0, 10) : null;
  await q(db, `UPDATE document SET current_version_id=$2, status='UPLOADED', rejection_reason=NULL, reviewed_by=NULL, reviewed_at=NULL, expiry_date=COALESCE($3, expiry_date) WHERE id=$1`, [doc.id, version.id, expiry]);
  return { versionId: version.id, versionNo: version.version_no, duplicate };
}

/** Customer-safe and staff views of a document. */
export const documentView = (d: any, audience: 'CUSTOMER' | 'STAFF') => ({
  id: d.id, title: d.title, docType: d.doc_type, status: d.status, mandatory: d.mandatory, requirementKey: d.requirement_key,
  expiryDate: d.expiry_date, rejectionReason: d.rejection_reason, updatedAt: d.updated_at,
  current: d.current_version_id ? { id: d.current_version_id, version: d.version_no, filename: d.original_filename, size: d.size_bytes, mime: d.detected_mime, scan: d.scan_status, uploadedAt: d.uploaded_at } : null,
  ...(audience === 'STAFF' ? { reviewedBy: d.reviewer_name, reviewedAt: d.reviewed_at, customerVisible: d.customer_visible } : {}),
});

export const DOC_SELECT = `SELECT d.*, v.version_no, v.original_filename, v.size_bytes, v.detected_mime, v.scan_status, v.uploaded_at, u.display_name AS reviewer_name
  FROM document d LEFT JOIN document_version v ON v.id=d.current_version_id LEFT JOIN app_user u ON u.id=d.reviewed_by`;

registerJob('document.rescan', async ({ versionId }) => {
  const db = getPool();
  const v = await maybe<any>(db, 'SELECT * FROM document_version WHERE id=$1', [versionId]);
  if (!v || v.scan_status !== 'PENDING') return { skipped: true };
  const { getObject } = await import('./storage.js');
  const r = await integrations().antivirus.scan(await getObject(v));
  if (r.status === 'ERROR') throw new Error('scanner unavailable');
  await q(db, 'UPDATE document_version SET scan_status=$2, scan_engine=$3, scanned_at=now() WHERE id=$1', [versionId, r.status, r.engine]);
  if (r.status === 'INFECTED') {
    await deleteObject(v.storage_key);
    await q(db, `UPDATE document SET status='REJECTED', rejection_reason='Failed security scan' WHERE current_version_id=$1`, [versionId]);
    await audit(db, SYSTEM, { action: 'MALWARE_DETECTED', entityType: 'document_version', entityId: versionId, outcome: 'DENIED', metadata: { engine: r.engine } });
  }
  return r;
});

/** Daily: mark documents past expiry. */
export async function expireDocuments(db: Db) {
  const rows = await q<{ id: string }>(db, `UPDATE document SET status='EXPIRED' WHERE expiry_date < current_date AND status IN ('VERIFIED','UPLOADED','UNDER_REVIEW') AND deleted_at IS NULL RETURNING id`);
  for (const r of rows) await q(db, `INSERT INTO document_event(document_id, event, actor_type) VALUES ($1,'EXPIRED','SYSTEM')`, [r.id]);
  return rows.length;
}
