import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { hmac, randomToken } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { loadFacility, resolveCustomer } from '../facilities/access.js';
import { DOC_SELECT, documentView, uploadToDocument } from './service.js';
import { getObject } from './storage.js';

/** Load a document the caller may access (via its facility, or the customer for customer-level documents). */
export async function loadDocument(db: ReturnType<typeof getPool>, req: FastifyRequest, documentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw notFound('Document');
  const d = await maybe<any>(db, `${DOC_SELECT} WHERE d.id=$1 AND d.deleted_at IS NULL`, [documentId]);
  if (!d) throw notFound('Document');
  if (d.facility_id) await loadFacility(db, req, d.facility_id);
  else await resolveCustomer(db, req, d.customer_id);
  if (req.auth!.subjectType === 'CUSTOMER' && !d.customer_visible) throw notFound('Document');
  return d;
}

async function readUpload(req: FastifyRequest) {
  const part = await req.file();
  if (!part) throw badRequest('NO_FILE', 'Attach a file to upload.');
  const buffer = await part.toBuffer();
  if (part.file.truncated) throw badRequest('FILE_TOO_LARGE', 'The file is too large.');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(part.fields)) if (v && typeof v === 'object' && 'value' in v && typeof (v as any).value === 'string') fields[k] = (v as any).value;
  return { buffer, filename: part.filename, mimetype: part.mimetype, fields };
}

export async function documentRoutes(app: FastifyInstance) {
  const db = getPool();

  app.get('/api/facilities/:id/documents', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const f = await loadFacility(db, req, id);
    const cust = req.auth!.subjectType === 'CUSTOMER';
    const rows = await q(db, `${DOC_SELECT} WHERE d.facility_id=$1 AND d.deleted_at IS NULL ${cust ? 'AND d.customer_visible' : ''} ORDER BY d.mandatory DESC, d.created_at`, [f.id]);
    return ok(reply, rows.map((d) => documentView(d, cust ? 'CUSTOMER' : 'STAFF')));
  });

  /** Additional (ad-hoc) document on a facility. */
  app.post('/api/facilities/:id/documents', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ title: z.string().trim().min(3).max(200), docType: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/).default('SUPPORTING'), customerVisible: z.boolean().default(true) }), req.body);
    const f = await loadFacility(db, req, id);
    const cust = req.auth!.subjectType === 'CUSTOMER';
    const d = await one<any>(db, `INSERT INTO document(customer_id, facility_id, doc_type, title, status, mandatory, customer_visible) VALUES ($1,$2,$3,$4,'REQUIRED',false,$5) RETURNING id`, [f.customer_id, f.id, body.docType, body.title, cust ? true : body.customerVisible]);
    await audit(db, actorOf(req), { action: 'DOCUMENT_CREATED', entityType: 'document', entityId: d.id, facilityId: f.id, customerId: f.customer_id, metadata: { title: body.title } });
    return ok(reply, { id: d.id }, 201);
  });

  app.post('/api/documents/:docId/upload', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { docId } = parse(z.object({ docId: z.string() }), req.params);
    const d = await loadDocument(db, req, docId);
    if (req.auth!.subjectType === 'STAFF') requireStaff(req);
    if (d.facility_id && req.auth!.subjectType === 'CUSTOMER') {
      const f = await one<any>(db, 'SELECT status FROM facility_request WHERE id=$1', [d.facility_id]);
      if (!['DRAFT', 'RETURNED', 'OFFER_ACCEPTED', 'FULFILMENT', 'IN_REVIEW', 'SUBMITTED'].includes(f.status)) throw conflict('LOCKED', 'Documents can no longer be changed on this request.');
    }
    const file = await readUpload(req);
    const res = await tx(async (c) => {
      const locked = await one<any>(c, 'SELECT * FROM document WHERE id=$1 FOR UPDATE', [d.id]);
      return uploadToDocument(c, actorOf(req), locked, file);
    });
    const fresh = await one(db, `${DOC_SELECT} WHERE d.id=$1`, [d.id]);
    return ok(reply, { ...documentView(fresh, req.auth!.subjectType === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF'), duplicateWarning: res.duplicate ? 'You have uploaded an identical file before.' : undefined }, 201);
  });

  app.get('/api/documents/:docId/versions', async (req, reply) => {
    const { docId } = parse(z.object({ docId: z.string() }), req.params);
    const d = await loadDocument(db, req, docId);
    const rows = await q(db, `SELECT id, version_no AS version, original_filename AS filename, size_bytes AS size, detected_mime AS mime, scan_status AS scan, uploaded_at AS "uploadedAt", uploaded_by_type AS "uploadedByType" FROM document_version WHERE document_id=$1 ORDER BY version_no DESC`, [d.id]);
    const events = req.auth!.subjectType === 'STAFF' ? await q(db, `SELECT e.event, e.note, e.created_at AS at, e.actor_type AS "actorType", COALESCE(u.display_name, cu.full_name) AS actor FROM document_event e LEFT JOIN app_user u ON u.id=e.actor_id LEFT JOIN customer_user cu ON cu.id=e.actor_id WHERE e.document_id=$1 ORDER BY e.created_at`, [d.id]) : [];
    return ok(reply, { versions: rows, events });
  });

  /** Issue a single-use, 60-second download grant bound to the caller's identity. */
  app.post('/api/documents/:docId/grant', async (req, reply) => {
    const { docId } = parse(z.object({ docId: z.string() }), req.params);
    const body = parse(z.object({ versionId: z.uuid().optional(), disposition: z.enum(['inline', 'attachment']).default('inline') }), req.body);
    const d = await loadDocument(db, req, docId);
    const versionId = body.versionId ?? d.current_version_id;
    if (!versionId) throw notFound('File');
    const v = await maybe<any>(db, 'SELECT id, scan_status FROM document_version WHERE id=$1 AND (document_id=$2 OR id=$3)', [versionId, d.id, d.current_version_id]);
    if (!v) throw notFound('File');
    if (v.scan_status !== 'CLEAN') throw conflict('NOT_SCANNED', 'This file is still being security-scanned. Try again shortly.');
    const token = randomToken();
    await q(db, `INSERT INTO document_access_grant(token_hash, version_id, subject_type, subject_id, disposition, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '60 seconds')`, [hmac(token, 'grant'), v.id, req.auth!.subjectType, req.auth!.subjectId, body.disposition]);
    await audit(db, actorOf(req), { action: 'DOCUMENT_ACCESS_GRANTED', entityType: 'document', entityId: d.id, facilityId: d.facility_id, customerId: d.customer_id, metadata: { versionId: v.id, disposition: body.disposition } });
    return ok(reply, { url: `/api/files/${token}`, expiresInSeconds: 60 });
  });

  app.get('/api/files/:token', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/) }), req.params);
    if (!req.auth) throw unauthorized();
    const g = await maybe<any>(db, `UPDATE document_access_grant SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING *`, [hmac(token, 'grant')]);
    if (!g) throw notFound('File');
    if (g.subject_type !== req.auth.subjectType || g.subject_id !== req.auth.subjectId) throw forbidden();
    const v = await one<any>(db, 'SELECT * FROM document_version WHERE id=$1', [g.version_id]);
    const buf = await getObject(v);
    const safeName = v.original_filename.replace(/[^A-Za-z0-9._ -]/g, '_');
    reply.header('Content-Type', v.detected_mime);
    reply.header('Content-Disposition', `${g.disposition}; filename="${safeName}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(buf);
  });

  app.post('/api/documents/:docId/review', async (req, reply) => {
    const { docId } = parse(z.object({ docId: z.string() }), req.params);
    const body = parse(z.object({ decision: z.enum(['UNDER_REVIEW', 'VERIFIED', 'REJECTED']), reason: z.string().trim().max(1000).optional(), expiryDate: z.iso.date().optional() }).refine((b) => b.decision !== 'REJECTED' || (b.reason && b.reason.length >= 5), { message: 'Give the customer a reason for rejection.', path: ['reason'] }), req.body);
    requireStaff(req, 'document.verify');
    const d = await loadDocument(db, req, docId);
    if (!d.current_version_id) throw conflict('NO_FILE', 'Nothing has been uploaded yet.');
    if (d.scan_status !== 'CLEAN') throw conflict('NOT_SCANNED', 'The file has not passed security scanning.');
    const actor = actorOf(req);
    await tx(async (c) => {
      await q(c, `UPDATE document SET status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now(), expiry_date=COALESCE($5, expiry_date) WHERE id=$1`, [d.id, body.decision, body.decision === 'REJECTED' ? body.reason : null, actor.id, body.expiryDate ?? null]);
      await q(c, `INSERT INTO document_event(document_id, version_id, event, actor_type, actor_id, note) VALUES ($1,$2,$3,'STAFF',$4,$5)`, [d.id, d.current_version_id, body.decision, actor.id, body.reason ?? null]);
      await audit(c, actor, { action: `DOCUMENT_${body.decision}`, entityType: 'document', entityId: d.id, facilityId: d.facility_id, customerId: d.customer_id, before: { status: d.status }, after: { status: body.decision }, metadata: { reason: body.reason } });
    });
    return ok(reply, documentView(await one(db, `${DOC_SELECT} WHERE d.id=$1`, [d.id]), 'STAFF'));
  });

  app.delete('/api/documents/:docId', async (req, reply) => {
    const { docId } = parse(z.object({ docId: z.string() }), req.params);
    const d = await loadDocument(db, req, docId);
    if (d.requirement_key) throw conflict('REQUIRED_DOCUMENT', 'Required documents cannot be removed; upload a replacement instead.');
    if (d.status === 'VERIFIED') throw conflict('VERIFIED', 'Verified documents cannot be removed.');
    await q(db, 'UPDATE document SET deleted_at=now() WHERE id=$1', [d.id]);
    await audit(db, actorOf(req), { action: 'DOCUMENT_DELETED', entityType: 'document', entityId: d.id, facilityId: d.facility_id, customerId: d.customer_id });
    return ok(reply, { removed: true });
  });
}
