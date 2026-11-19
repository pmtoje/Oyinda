import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { unprocessable } from '../../lib/errors.js';
import { splitCsv } from '../analysis/statement-parser.js';
import { MIME } from '../documents/mime.js';
import { audit, type Actor } from '../audit/audit.js';
import { revokeAllFor } from '../identity/session.js';

/**
 * Staff directory from a spreadsheet — the interim substitute for Active Directory synchronisation.
 * One row per staff member. For every user in the file, the Roles column is the complete set of roles
 * (as an AD group sync would be): roles not listed are removed. Users not in the file are untouched.
 */
export const COLUMNS = [
  { key: 'username', header: 'Username (AD)', required: true, note: 'Network / AD login, e.g. j.doe' },
  { key: 'name', header: 'Full name', required: true, note: '' },
  { key: 'email', header: 'E-mail', required: true, note: 'Bank e-mail address' },
  { key: 'staffNumber', header: 'Staff number', required: false, note: 'Used to link customers to their Relationship Manager' },
  { key: 'directorate', header: 'Directorate code', required: true, note: 'See the Reference sheet' },
  { key: 'businessUnit', header: 'Business unit code', required: true, note: 'See the Reference sheet' },
  { key: 'roles', header: 'Roles', required: true, note: 'Role codes separated by commas; the complete set for this user' },
  { key: 'manager', header: 'Line manager username', required: false, note: 'Reporting line, e.g. the RM’s Team Lead' },
  { key: 'limits', header: 'Personal approval limits (NGN)', required: false, note: 'ROLE=amount pairs separated by semicolons, e.g. ED=150000000' },
  { key: 'sectors', header: 'Sectors', required: false, note: 'Sector codes for sector analysts, separated by commas' },
  { key: 'status', header: 'Status', required: false, note: 'ACTIVE (default) or INACTIVE' },
] as const;
type Key = (typeof COLUMNS)[number]['key'];
export type ImportRow = Record<Key, string> & { rowNo: number };

const cellText = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) return cellText(v.result);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((x: any) => x.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text); // hyperlink cells (e-mail addresses)
  return String(v).trim();
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Read the first worksheet (or CSV) into rows keyed by column. Unknown columns are ignored; missing required columns fail. */
export async function readSheet(buf: Buffer, mime: string): Promise<ImportRow[]> {
  let grid: string[][];
  if (mime === MIME.XLSX) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet('Staff') ?? wb.worksheets[0];
    if (!ws) throw unprocessable('NO_SHEET', 'The workbook has no worksheets.');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (r) => { grid.push((r.values as unknown[]).slice(1).map(cellText)); });
  } else if (mime === MIME.CSV) {
    grid = splitCsv(buf.toString('utf8').replace(/^﻿/, '')).map((r) => r.map((c) => String(c ?? '').trim()));
  } else throw unprocessable('FILE_TYPE', 'Upload the staff list as an Excel workbook (.xlsx) or CSV.');
  const headerIdx = grid.findIndex((r) => r.some((c) => norm(c) === norm(COLUMNS[0].header) || norm(c) === 'username'));
  if (headerIdx < 0) throw unprocessable('NO_HEADER', `The header row was not found. Use the template: the first column is "${COLUMNS[0].header}".`);
  const header = grid[headerIdx]!.map(norm);
  const pos = Object.fromEntries(COLUMNS.map((c) => [c.key, header.findIndex((h) => h === norm(c.header) || h === norm(c.key))]));
  const missing = COLUMNS.filter((c) => c.required && pos[c.key]! < 0).map((c) => c.header);
  if (missing.length) throw unprocessable('MISSING_COLUMNS', `Missing columns: ${missing.join(', ')}.`, missing);
  const rows: ImportRow[] = [];
  grid.slice(headerIdx + 1).forEach((r, i) => {
    if (r.every((c) => !c)) return;
    const row = { rowNo: headerIdx + i + 2 } as ImportRow;
    for (const c of COLUMNS) (row as any)[c.key] = pos[c.key]! >= 0 ? (r[pos[c.key]!] ?? '').trim() : '';
    rows.push(row);
  });
  if (!rows.length) throw unprocessable('EMPTY', 'The file contains no staff rows.');
  if (rows.length > 5000) throw unprocessable('TOO_MANY_ROWS', 'Upload at most 5,000 staff per file.');
  return rows;
}

const list = (s: string) => [...new Set(s.split(/[,;\n]/).map((x) => x.trim().toUpperCase()).filter(Boolean))];

export interface PreviewRow { rowNo: number; username: string; name: string; action: 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'ERROR'; changes: string[]; errors: string[]; privileged: boolean }

/** Validate every row and work out exactly what would change. Pure read; nothing is written. */
export async function previewImport(db: Db, rows: ImportRow[], makerId: string) {
  const roles = new Map((await q<any>(db, 'SELECT code, is_privileged FROM role')).map((r) => [r.code, r]));
  const dirs = new Set((await q<any>(db, 'SELECT code FROM directorate')).map((r) => r.code));
  const bus = new Map((await q<any>(db, 'SELECT code, directorate_code FROM business_unit')).map((r) => [r.code, r.directorate_code]));
  const sectors = new Set((await q<any>(db, 'SELECT code FROM sector')).map((r) => r.code));
  const existing = new Map((await q<any>(db, `SELECT u.*, m.ad_username AS manager_username,
      COALESCE((SELECT array_agg(role_code ORDER BY role_code) FROM user_role WHERE user_id=u.id), '{}') AS roles,
      COALESCE((SELECT array_agg(sector_code ORDER BY sector_code) FROM user_sector WHERE user_id=u.id), '{}') AS sectors,
      COALESCE((SELECT json_object_agg(role_code, limit_minor) FROM user_approval_limit l WHERE l.user_id=u.id AND l.effective_to IS NULL), '{}') AS limits
    FROM app_user u LEFT JOIN app_user m ON m.id=u.manager_id`)).map((u) => [u.ad_username.toLowerCase(), u]));
  const inFile = new Map<string, number>();
  for (const r of rows) { const k = r.username.toLowerCase(); if (k) inFile.set(k, (inFile.get(k) ?? 0) + 1); }
  const emails = new Map<string, number>();
  for (const r of rows) { const k = r.email.toLowerCase(); if (k) emails.set(k, (emails.get(k) ?? 0) + 1); }
  const maker = await maybe<any>(db, 'SELECT ad_username FROM app_user WHERE id=$1', [makerId]);

  const preview: PreviewRow[] = rows.map((r) => {
    const errors: string[] = [];
    const changes: string[] = [];
    const u = r.username.toLowerCase();
    const cur = existing.get(u);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(r.username)) errors.push('Username must be 2–64 letters, digits, dots, hyphens or underscores.');
    if ((inFile.get(u) ?? 0) > 1) errors.push('This username appears more than once in the file.');
    if (maker && u === maker.ad_username.toLowerCase()) errors.push('You cannot change your own access through an import.');
    if (r.name.length < 3 || r.name.length > 120) errors.push('Full name must be 3–120 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) || r.email.length > 200) errors.push('E-mail address is not valid.');
    else if ((emails.get(r.email.toLowerCase()) ?? 0) > 1) errors.push('This e-mail appears more than once in the file.');
    else { const other = [...existing.values()].find((x) => x.email.toLowerCase() === r.email.toLowerCase() && x.ad_username.toLowerCase() !== u); if (other) errors.push(`E-mail is already used by ${other.ad_username}.`); }
    if (r.staffNumber) { const other = [...existing.values()].find((x) => x.staff_number === r.staffNumber && x.ad_username.toLowerCase() !== u); if (other) errors.push(`Staff number is already used by ${other.ad_username}.`); }
    const dir = r.directorate.toUpperCase(), bu = r.businessUnit.toUpperCase();
    if (!dirs.has(dir)) errors.push(`Unknown directorate "${r.directorate}".`);
    if (!bus.has(bu)) errors.push(`Unknown business unit "${r.businessUnit}".`);
    else if (dirs.has(dir) && bus.get(bu) !== dir) errors.push(`Business unit ${bu} belongs to directorate ${bus.get(bu)}, not ${dir}.`);
    const wantRoles = list(r.roles);
    if (!wantRoles.length) errors.push('At least one role is required.');
    for (const x of wantRoles) if (!roles.has(x)) errors.push(`Unknown role "${x}".`);
    const wantSectors = list(r.sectors);
    for (const x of wantSectors) if (!sectors.has(x)) errors.push(`Unknown sector "${x}".`);
    const status = (r.status || 'ACTIVE').toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) errors.push('Status must be ACTIVE or INACTIVE.');
    const mgr = r.manager.toLowerCase();
    if (mgr && mgr === u) errors.push('A user cannot be their own line manager.');
    else if (mgr && !existing.has(mgr) && !inFile.has(mgr)) errors.push(`Line manager "${r.manager}" is not an existing user or in this file.`);
    const limits: Record<string, number> = {};
    for (const part of r.limits.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*₦?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/i.exec(part);
      if (!m) { errors.push(`Approval limit "${part}" must look like ROLE=amount.`); continue; }
      const role = m[1]!.toUpperCase();
      if (!wantRoles.includes(role)) errors.push(`Approval limit for ${role}, but the user does not hold that role.`);
      limits[role] = Math.round(Number(m[2]!.replace(/,/g, '')) * 100);
    }
    const privileged = wantRoles.some((x) => roles.get(x)?.is_privileged) || (cur?.roles ?? []).some((x: string) => roles.get(x)?.is_privileged);
    if (!errors.length) {
      if (!cur) changes.push(`Create ${r.name} (${dir} / ${bu}) with roles ${wantRoles.join(', ')}`);
      else {
        if (cur.display_name !== r.name) changes.push(`Name: ${cur.display_name} → ${r.name}`);
        if (cur.email.toLowerCase() !== r.email.toLowerCase()) changes.push(`E-mail: ${cur.email} → ${r.email.toLowerCase()}`);
        if ((cur.staff_number ?? '') !== r.staffNumber && r.staffNumber) changes.push(`Staff number: ${cur.staff_number ?? '—'} → ${r.staffNumber}`);
        if (cur.directorate_code !== dir || cur.business_unit_code !== bu) changes.push(`Unit: ${cur.directorate_code ?? '—'} / ${cur.business_unit_code ?? '—'} → ${dir} / ${bu}`);
        if (cur.status !== status) changes.push(`Status: ${cur.status} → ${status}`);
        const add = wantRoles.filter((x) => !cur.roles.includes(x)), del = cur.roles.filter((x: string) => !wantRoles.includes(x));
        if (add.length) changes.push(`Grant roles: ${add.join(', ')}`);
        if (del.length) changes.push(`Remove roles: ${del.join(', ')}`);
        if ((cur.manager_username ?? '').toLowerCase() !== mgr) changes.push(`Line manager: ${cur.manager_username ?? '—'} → ${r.manager || '—'}`);
        const curSec = [...cur.sectors].sort().join(','), newSec = [...wantSectors].sort().join(',');
        if (curSec !== newSec) changes.push(`Sectors: ${curSec || '—'} → ${newSec || '—'}`);
        for (const [role, v] of Object.entries(limits)) if (Number(cur.limits[role] ?? -1) !== v) changes.push(`Approval limit ${role}: ${cur.limits[role] === undefined ? '—' : `₦${(Number(cur.limits[role]) / 100).toLocaleString('en-NG')}`} → ₦${(v / 100).toLocaleString('en-NG')}`);
        for (const role of Object.keys(cur.limits)) if (!(role in limits) && wantRoles.includes(role)) changes.push(`Approval limit ${role}: removed`);
      }
    }
    return { rowNo: r.rowNo, username: r.username, name: r.name, action: errors.length ? 'ERROR' : !cur ? 'CREATE' : changes.length ? 'UPDATE' : 'NO_CHANGE', changes, errors, privileged };
  });
  const count = (a: string) => preview.filter((p) => p.action === a).length;
  return { preview, summary: { rows: rows.length, create: count('CREATE'), update: count('UPDATE'), unchanged: count('NO_CHANGE'), errors: count('ERROR'), privilegedChanges: preview.filter((p) => p.privileged && p.action !== 'NO_CHANGE' && p.action !== 'ERROR').length } };
}

/** Apply an approved batch in one transaction. Re-validates first: the directory may have changed since upload. */
export async function applyImport(db: Db, actor: Actor, batch: any) {
  const { preview } = await previewImport(db, batch.rows, batch.maker_id);
  const bad = preview.filter((p) => p.action === 'ERROR');
  if (bad.length) throw unprocessable('IMPORT_STALE', 'The directory has changed since this file was uploaded and some rows are no longer valid. Reject it and upload a corrected file.', bad);
  const approver = await one<any>(db, 'SELECT ad_username FROM app_user WHERE id=$1', [actor.id]);
  if (preview.some((p) => p.username.toLowerCase() === approver.ad_username.toLowerCase() && p.action !== 'NO_CHANGE')) throw unprocessable('SELF', 'You cannot approve an import that changes your own access.');
  const rows: ImportRow[] = batch.rows;
  const byUser = new Map<string, string>();
  const applied = { created: 0, updated: 0, rolesGranted: 0, rolesRemoved: 0, sessionsEnded: 0, createdUserIds: [] as string[] };
  // Pass 1: users. Pass 2: reporting lines (managers may be created in the same file).
  for (const r of rows) {
    const p = preview.find((x) => x.rowNo === r.rowNo)!;
    const status = (r.status || 'ACTIVE').toUpperCase();
    const before = await maybe<any>(db, 'SELECT id, status FROM app_user WHERE lower(ad_username)=lower($1) FOR UPDATE', [r.username]);
    let id: string;
    if (!before) {
      id = (await one<any>(db, `INSERT INTO app_user(ad_username, display_name, email, staff_number, directorate_code, business_unit_code, status, source, source_batch_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'SPREADSHEET',$8) RETURNING id`, [r.username, r.name, r.email.toLowerCase(), r.staffNumber || null, r.directorate.toUpperCase(), r.businessUnit.toUpperCase(), status, batch.id])).id;
      applied.created++;
      if (status === 'ACTIVE') applied.createdUserIds.push(id);
    } else {
      id = before.id;
      if (p.action === 'UPDATE') applied.updated++;
      await q(db, `UPDATE app_user SET display_name=$2, email=$3, staff_number=COALESCE($4, staff_number), directorate_code=$5, business_unit_code=$6, status=$7, source='SPREADSHEET', source_batch_id=$8 WHERE id=$1`,
        [id, r.name, r.email.toLowerCase(), r.staffNumber || null, r.directorate.toUpperCase(), r.businessUnit.toUpperCase(), status, batch.id]);
    }
    byUser.set(r.username.toLowerCase(), id);
    const want = list(r.roles);
    const cur = (await q<{ role_code: string }>(db, 'SELECT role_code FROM user_role WHERE user_id=$1', [id])).map((x) => x.role_code);
    for (const role of want.filter((x) => !cur.includes(x))) { await q(db, 'INSERT INTO user_role(user_id, role_code, granted_by) VALUES ($1,$2,$3)', [id, role, actor.id]); applied.rolesGranted++; }
    const removed = cur.filter((x) => !want.includes(x));
    if (removed.length) { await q(db, 'DELETE FROM user_role WHERE user_id=$1 AND role_code = ANY($2)', [id, removed]); applied.rolesRemoved += removed.length; await q(db, 'UPDATE user_approval_limit SET effective_to=now() WHERE user_id=$1 AND role_code = ANY($2) AND effective_to IS NULL', [id, removed]); }
    await q(db, 'DELETE FROM user_sector WHERE user_id=$1', [id]);
    for (const sc of list(r.sectors)) await q(db, 'INSERT INTO user_sector(user_id, sector_code) VALUES ($1,$2)', [id, sc]);
    const limits = Object.fromEntries(r.limits.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, v] = x.split('='); return [k!.trim().toUpperCase(), Math.round(Number(v!.replace(/[₦,\s]/g, '')) * 100)]; }));
    const curLimits = new Map((await q<any>(db, 'SELECT role_code, limit_minor FROM user_approval_limit WHERE user_id=$1 AND effective_to IS NULL', [id])).map((x) => [x.role_code, Number(x.limit_minor)]));
    for (const [role, v] of Object.entries(limits)) if (curLimits.get(role) !== v) {
      await q(db, 'UPDATE user_approval_limit SET effective_to=now() WHERE user_id=$1 AND role_code=$2 AND effective_to IS NULL', [id, role]);
      await q(db, 'INSERT INTO user_approval_limit(user_id, role_code, limit_minor, set_by) VALUES ($1,$2,$3,$4)', [id, role, v, actor.id]);
    }
    for (const role of curLimits.keys()) if (!(role in limits) && want.includes(role)) await q(db, 'UPDATE user_approval_limit SET effective_to=now() WHERE user_id=$1 AND role_code=$2 AND effective_to IS NULL', [id, role]);
    // Access changed or deactivated: end live sessions so the new access applies at the next sign-in.
    if (before && (removed.length || want.some((x) => !cur.includes(x)) || status !== before.status)) { await revokeAllFor(db, 'STAFF', id, 'directory_import'); applied.sessionsEnded++; }
    if (p.action !== 'NO_CHANGE') await audit(db, actor, { action: before ? 'USER_UPDATED_BY_IMPORT' : 'USER_CREATED_BY_IMPORT', entityType: 'app_user', entityId: id, metadata: { batch: batch.id, row: r.rowNo, changes: p.changes } });
  }
  for (const r of rows) {
    const id = byUser.get(r.username.toLowerCase())!;
    const mgr = r.manager ? byUser.get(r.manager.toLowerCase()) ?? (await maybe<any>(db, 'SELECT id FROM app_user WHERE lower(ad_username)=lower($1)', [r.manager]))?.id : null;
    await q(db, 'UPDATE app_user SET manager_id=$2 WHERE id=$1', [id, mgr ?? null]);
  }
  return applied;
}
