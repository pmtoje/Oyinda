import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { loadFacility } from '../facilities/access.js';
import { decisionView, generateMemo, generateTermSheet } from './service.js';
import { CAM_EDITABLE } from './cam.js';
import { facilityEfficiency } from '../analysis/efficiency.js';
import { riskFlags } from './risk-flags.js';

const idParam = z.object({ id: z.string() });

export async function docgenRoutes(app: FastifyInstance) {
  const db = getPool();
  app.post('/api/facilities/:id/memo', async (req, reply) => {
    requireStaff(req, 'memo.generate');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(z.object({ recommendation: z.enum(['APPROVE', 'APPROVE_WITH_CONDITIONS', 'DECLINE']), commentary: z.string().trim().min(20).max(8000), mitigants: z.array(z.string().trim().min(5).max(500)).max(20).default([]), conditions: z.array(z.string().trim().min(5).max(500)).max(30).default([]), additionalRisks: z.array(z.string().trim().min(5).max(500)).max(20).default([]) }), req.body);
    const g = await tx((c) => generateMemo(c, actorOf(req), f.id, b));
    return ok(reply, { id: g.id, version: g.version_no, documentId: g.rendered_document_id, executiveSummary: g.content.executiveSummary }, 201);
  });

  app.get('/api/facilities/:id/generated/:kind', async (req, reply) => {
    requireStaff(req);
    const { id, kind } = parse(z.object({ id: z.string(), kind: z.enum(['CREDIT_MEMO', 'TERM_SHEET', 'OFFER_LETTER']) }), req.params);
    const f = await loadFacility(db, req, id);
    const rows = await q<any>(db, `SELECT g.id, g.version_no, g.content, g.rendered_document_id, g.based_on_version, g.edit_reason, g.created_at, COALESCE(u.display_name, 'Gazelle') AS generated_by FROM generated_document g LEFT JOIN app_user u ON u.id=g.generated_by_id WHERE g.facility_id=$1 AND g.kind=$2 ORDER BY g.version_no DESC`, [f.id, kind]);
    return ok(reply, rows.map((r, i) => ({ id: r.id, version: r.version_no, documentId: r.rendered_document_id, basedOn: r.based_on_version, editReason: r.edit_reason, generatedBy: r.generated_by, createdAt: r.created_at, ...(i === 0 ? { content: r.content } : {}) })));
  });

  app.post('/api/facilities/:id/term-sheet', async (req, reply) => {
    requireStaff(req, 'memo.generate');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(z.object({ overrides: z.object(Object.fromEntries(CAM_EDITABLE.map((k) => [k, z.string().trim().max(8000).optional()]))).strict().optional(), reason: z.string().trim().min(5).max(500).optional() }), req.body);
    let edits: { overrides: Record<string, string>; reason: string; basedOn: number } | undefined;
    if (b.overrides && Object.keys(b.overrides).length) {
      const prev = await maybe<any>(db, `SELECT version_no FROM generated_document WHERE facility_id=$1 AND kind='TERM_SHEET' ORDER BY version_no DESC LIMIT 1`, [f.id]);
      if (!prev) throw notFound('Previous term sheet');
      if (!b.reason) return reply.status(400).send({ error: { code: 'REASON', message: 'Give a reason for editing the term sheet.' } });
      edits = { overrides: b.overrides as Record<string, string>, reason: b.reason, basedOn: prev.version_no };
    }
    const g = await tx((c) => generateTermSheet(c, actorOf(req), f.id, edits));
    return ok(reply, { id: g.id, version: g.version_no, documentId: g.rendered_document_id }, 201);
  });

  app.get('/api/facilities/:id/efficiency-ratio', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, await facilityEfficiency(db, f.id));
  });

  app.get('/api/facilities/:id/decision-view', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, await decisionView(db, f.id));
  });

  app.get('/api/facilities/:id/risk-flags', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, await riskFlags(db, f.id));
  });
}
