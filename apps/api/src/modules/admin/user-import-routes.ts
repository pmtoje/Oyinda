import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { sha256Hex } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { detectMime, MIME } from '../documents/mime.js';
import { ROLES } from '../identity/rbac.js';
import { issueStaffLink, localStaffAuth } from '../identity/staff-credentials.js';
import { applyImport, COLUMNS, previewImport, readSheet } from './user-import.js';

const view = (b: any, full = false) => ({
  id: b.id, filename: b.filename, status: b.status, rowCount: b.row_count, summary: b.summary, createdAt: b.created_at, makerId: b.maker_id, maker: b.maker_name, checker: b.checker_name, decidedAt: b.decided_at, decisionNote: b.decision_note, appliedSummary: b.applied_summary,
  ...(full ? { preview: b.preview } : {}),
});
const SELECT = `SELECT b.*, m.display_name AS maker_name, c.display_name AS checker_name FROM user_import_batch b JOIN app_user m ON m.id=b.maker_id LEFT JOIN app_user c ON c.id=b.checker_id`;

/** Staff directory by spreadsheet — the interim route until Active Directory synchronisation is integrated. */
export async function userImportRoutes(app: FastifyInstance) {
  const db = getPool();

  app.get('/api/admin/user-imports/template.xlsx', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gazelle by Alternative Bank';
    const ws = wb.addWorksheet('Staff');
    ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));
    ws.getRow(1).font = { bold: true };
    COLUMNS.forEach((c, i) => { ws.getRow(1).getCell(i + 1).note = `${c.required ? 'Required. ' : 'Optional. '}${c.note}`; });
    ws.addRow({ username: 'example.user', name: 'Example User (delete this row)', email: 'example.user@altbank.ng', staffNumber: 'S00000', directorate: 'COMM', businessUnit: 'LAG-COMM-1', roles: 'RM', manager: 'example.teamlead', limits: '', sectors: '', status: 'ACTIVE' });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const ref = wb.addWorksheet('Reference');
    ref.columns = [{ header: 'Type', key: 't', width: 14 }, { header: 'Code', key: 'c', width: 24 }, { header: 'Name', key: 'n', width: 52 }];
    ref.getRow(1).font = { bold: true };
    for (const r of ROLES) ref.addRow({ t: 'Role', c: r.code, n: `${r.name}${r.privileged ? ' (privileged)' : ''}` });
    for (const d of await q<any>(db, 'SELECT code, name FROM directorate ORDER BY code')) ref.addRow({ t: 'Directorate', c: d.code, n: d.name });
    for (const b of await q<any>(db, 'SELECT code, name, directorate_code FROM business_unit ORDER BY code')) ref.addRow({ t: 'Business unit', c: b.code, n: `${b.name} (directorate ${b.directorate_code})` });
    for (const s of await q<any>(db, 'SELECT code, name FROM sector ORDER BY code')) ref.addRow({ t: 'Sector', c: s.code, n: s.name });
    reply.header('Content-Type', MIME.XLSX).header('Content-Disposition', 'attachment; filename="gazelle-staff-import-template.xlsx"').header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  app.post('/api/admin/user-imports', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } });
    if (!part) throw badRequest('NO_FILE', 'Attach the staff spreadsheet.');
    const buf = await part.toBuffer();
    const mime = detectMime(buf);
    if (mime !== MIME.XLSX && mime !== MIME.CSV) throw badRequest('FILE_TYPE', 'Upload an Excel workbook (.xlsx) or CSV file.');
    const rows = await readSheet(buf, mime);
    const { preview, summary } = await previewImport(db, rows, s.id);
    const filename = String(part.filename ?? 'staff.xlsx').replace(/[^\w .()-]/g, '_').slice(0, 120);
    const b = await one<any>(db, `INSERT INTO user_import_batch(filename, file_sha256, status, row_count, rows, preview, summary, maker_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [filename, sha256Hex(buf), summary.errors ? 'INVALID' : 'PENDING_APPROVAL', rows.length, JSON.stringify(rows), JSON.stringify(preview), JSON.stringify(summary), s.id]);
    await audit(db, actorOf(req), { action: 'USER_IMPORT_UPLOADED', entityType: 'user_import_batch', entityId: b.id, metadata: { filename, ...summary } });
    return ok(reply, view({ ...b, maker_name: s.name }, true), 201);
  });

  app.get('/api/admin/user-imports', async (req, reply) => {
    requireStaff(req, 'user.manage');
    return ok(reply, (await q<any>(db, `${SELECT} ORDER BY b.created_at DESC LIMIT 50`)).map((b) => view(b)));
  });

  app.get('/api/admin/user-imports/:bid', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const { bid } = parse(z.object({ bid: z.uuid() }), req.params);
    const b = await maybe<any>(db, `${SELECT} WHERE b.id=$1`, [bid]);
    if (!b) throw notFound('Import');
    return ok(reply, view(b, true));
  });

  /** Checker: apply or reject. The approver must differ from the uploader and cannot be changed by the batch. */
  app.post('/api/admin/user-imports/:bid/decide', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { bid } = parse(z.object({ bid: z.uuid() }), req.params);
    const body = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(500).optional() }), req.body);
    const out = await tx(async (c) => {
      const b = await maybe<any>(c, 'SELECT * FROM user_import_batch WHERE id=$1 FOR UPDATE', [bid]);
      if (!b) throw notFound('Import');
      if (b.status !== 'PENDING_APPROVAL') throw conflict('STATE', 'This import is not awaiting approval.');
      if (b.maker_id === s.id) throw forbidden('Maker-checker: you uploaded this file and cannot approve it.');
      if (body.decision === 'REJECT') {
        await q(c, `UPDATE user_import_batch SET status='REJECTED', checker_id=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [bid, s.id, body.note ?? null]);
        await audit(c, actorOf(req), { action: 'USER_IMPORT_REJECTED', entityType: 'user_import_batch', entityId: bid, metadata: { note: body.note } });
        return { status: 'REJECTED' };
      }
      const { createdUserIds, ...applied } = await applyImport(c, actorOf(req), b);
      // Interim local sign-in: new staff receive a single-use activation link at their work e-mail.
      const links = localStaffAuth() ? await Promise.all(createdUserIds.map((id) => issueStaffLink(c, actorOf(req), id, 'ACTIVATE'))) : [];
      const summary = { ...applied, activationLinksSent: links.length };
      await q(c, `UPDATE user_import_batch SET status='APPLIED', checker_id=$2, decided_at=now(), decision_note=$3, applied_summary=$4 WHERE id=$1`, [bid, s.id, body.note ?? null, JSON.stringify(summary)]);
      await audit(c, actorOf(req), { action: 'USER_IMPORT_APPLIED', entityType: 'user_import_batch', entityId: bid, metadata: summary });
      return { status: 'APPLIED', applied: summary, links };
    });
    for (const l of (out as any).links ?? []) await l.send();
    delete (out as any).links;
    return ok(reply, out);
  });

  app.post('/api/admin/user-imports/:bid/withdraw', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { bid } = parse(z.object({ bid: z.uuid() }), req.params);
    const r = await q(db, `UPDATE user_import_batch SET status='WITHDRAWN', decided_at=now() WHERE id=$1 AND maker_id=$2 AND status IN ('PENDING_APPROVAL','INVALID') RETURNING id`, [bid, s.id]);
    if (!r.length) throw conflict('STATE', 'Only the uploader can withdraw an import that has not been decided.');
    await audit(db, actorOf(req), { action: 'USER_IMPORT_WITHDRAWN', entityType: 'user_import_batch', entityId: bid });
    return ok(reply, { withdrawn: true });
  });
}
