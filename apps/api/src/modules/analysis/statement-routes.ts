import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { sha256Hex } from '../../lib/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { maskAccount } from '../../lib/mask.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit, SYSTEM } from '../audit/audit.js';
import { loadFacility } from '../facilities/access.js';
import { storeVersion } from '../documents/service.js';
import { getObject } from '../documents/storage.js';
import { MIME } from '../documents/mime.js';
import { parseStatementFile } from './statement-parser.js';
import { analyseStatements } from './statement-analysis.js';
import { integrations } from '../../integrations/index.js';

const meta = z.object({
  bankName: z.string().trim().min(2).max(120),
  accountNumber: z.string().regex(/^[0-9]{10}$/, 'Enter the 10-digit account number.'),
  currency: z.string().regex(/^[A-Z]{3}$/),
  periodStart: z.iso.date(), periodEnd: z.iso.date(),
}).refine((m) => m.periodEnd >= m.periodStart, { message: 'Period end must not be before the start.', path: ['periodEnd'] });

export const statementView = (s: any) => ({
  id: s.id, bankName: s.bank_name, isAlternativeBank: s.is_alternative_bank, account: maskAccount(s.account_number), currency: s.currency, periodStart: s.period_start, periodEnd: s.period_end,
  status: s.status, transactionCount: s.transaction_count, uncertainCount: s.uncertain_count, issues: s.issues, parser: s.parser, openingBalanceMinor: s.opening_balance_minor, closingBalanceMinor: s.closing_balance_minor, validatedAt: s.validated_at, createdAt: s.created_at,
});

registerJob('statement.parse', async ({ statementId }) => {
  const db = getPool();
  const s = await maybe<any>(db, 'SELECT * FROM bank_statement WHERE id=$1', [statementId]);
  if (!s || !['QUEUED', 'PROCESSING'].includes(s.status)) return { skipped: true };
  await q(db, `UPDATE bank_statement SET status='PROCESSING' WHERE id=$1`, [statementId]);
  const v = await one<any>(db, 'SELECT * FROM document_version WHERE id=$1', [s.document_version_id]);
  const res = await parseStatementFile(await getObject(v), v.detected_mime);
  const issues = [...res.issues];
  if (res.detectedAccountNumber && res.detectedAccountNumber !== s.account_number) issues.push(`Account number in the file (${maskAccount(res.detectedAccountNumber)}) differs from the account selected (${maskAccount(s.account_number)}).`);
  const outside = res.transactions.filter((t) => t.txnDate && (t.txnDate < s.period_start || t.txnDate > s.period_end)).length;
  if (outside) issues.push(`${outside} transaction(s) fall outside the declared statement period.`);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bank_transaction WHERE statement_id=$1', [statementId]);
    for (const t of res.transactions) {
      await client.query(`INSERT INTO bank_transaction(statement_id, line_no, txn_date, value_date, description_raw, description_norm, category, debit_minor, credit_minor, balance_minor, uncertain, uncertain_reason, txn_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [statementId, t.lineNo, t.txnDate, t.valueDate, t.descriptionRaw, t.descriptionNorm, t.category, t.debitMinor, t.creditMinor, t.balanceMinor, t.uncertain, t.uncertainReason, t.fingerprint]);
    }
    const first = res.transactions.find((t) => t.balanceMinor !== null);
    const last = [...res.transactions].reverse().find((t) => t.balanceMinor !== null);
    const unc = res.transactions.filter((t) => t.uncertain).length;
    const status = !res.ok ? (v.detected_mime === MIME.PDF || v.detected_mime === MIME.PNG || v.detected_mime === MIME.JPEG ? 'NEEDS_REVIEW' : 'FAILED') : unc > 0 || issues.length > 0 ? 'NEEDS_REVIEW' : 'PARSED';
    await client.query(`UPDATE bank_statement SET status=$2, parser=$3, detected_account_number=$4, transaction_count=$5, uncertain_count=$6, issues=$7, opening_balance_minor=$8, closing_balance_minor=$9 WHERE id=$1`,
      [statementId, status, res.parser, res.detectedAccountNumber, res.transactions.length, unc, JSON.stringify(issues), first ? first.balanceMinor! + first.debitMinor - first.creditMinor : null, last?.balanceMinor ?? null]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await audit(db, SYSTEM, { action: 'STATEMENT_PARSED', entityType: 'bank_statement', entityId: statementId, customerId: s.customer_id, facilityId: s.facility_id, metadata: { parser: res.parser, transactions: res.transactions.length, issues: issues.length } });
  return { transactions: res.transactions.length };
});

export async function statementRoutes(app: FastifyInstance) {
  const db = getPool();

  app.post('/api/facilities/:id/bank-statements', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    if (req.auth!.subjectType === 'STAFF') requireStaff(req, 'financials.edit');
    const part = await req.file();
    if (!part) throw badRequest('NO_FILE', 'Attach the statement file.');
    const buffer = await part.toBuffer();
    const fields = Object.fromEntries(Object.entries(part.fields).filter(([, v]: any) => v && typeof v.value === 'string').map(([k, v]: any) => [k, v.value]));
    const m = parse(meta, fields);
    const res = await receiveStatement(req, f, m, buffer, part.filename, part.mimetype);
    return ok(reply, { ...statementView(res), message: 'Statement received. Analysis is running; this page updates when it completes.' }, 202);
  });

  /**
   * SWR §2: spool an Alternative Bank statement directly from the core banking system. Only accounts that the
   * Bank holds for this facility's customer can be requested (SWR technology control 6) — the account is never
   * taken on trust from the client, and another customer's account is indistinguishable from a non-existent one.
   */
  app.post('/api/facilities/:id/bank-statements/spool', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    if (req.auth!.subjectType === 'STAFF') requireStaff(req, 'financials.edit');
    const b = parse(z.object({ accountNumber: z.string().regex(/^[0-9]{10}$/), periodStart: z.iso.date(), periodEnd: z.iso.date() }).refine((x) => x.periodEnd >= x.periodStart, 'The period end must be after the start.'), req.body);
    const own = await maybe<any>(db, 'SELECT account_number, currency FROM customer_account WHERE account_number=$1 AND customer_id=$2', [b.accountNumber, f.customer_id]);
    if (!own) {
      await audit(db, actorOf(req), { action: 'STATEMENT_SPOOL_REFUSED', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: f.customer_id, outcome: 'FAILURE', metadata: { account: maskAccount(b.accountNumber) } });
      throw notFound('Account');
    }
    const months = (new Date(b.periodEnd).getTime() - new Date(b.periodStart).getTime()) / (30.44 * 86400_000);
    if (months > 13) throw unprocessable('PERIOD_TOO_LONG', 'Request at most 12 months per statement.');
    const st = await integrations().cba.getStatement({ accountNumber: b.accountNumber, from: b.periodStart, to: b.periodEnd });
    const res = await receiveStatement(req, f, { bankName: 'Alternative Bank', accountNumber: b.accountNumber, currency: st.currency, periodStart: b.periodStart, periodEnd: b.periodEnd }, st.csv, `altbank-${b.accountNumber.slice(-4)}-${b.periodStart}-${b.periodEnd}.csv`, 'text/csv', integrations().cba.mode);
    return ok(reply, { ...statementView(res), message: `Statement retrieved from core banking${integrations().cba.mode === 'MOCK' ? ' (MOCK data)' : ''}. Analysis is running.` }, 202);
  });

  async function receiveStatement(req: any, f: any, m: { bankName: string; accountNumber: string; currency: string; periodStart: string; periodEnd: string }, buffer: Buffer, filename: string, mimetype: string, spooledFrom?: string) {
    const actor = actorOf(req);
    const sha = sha256Hex(buffer);
    const altBank = !!(await maybe(db, 'SELECT 1 FROM customer_account WHERE account_number=$1 AND customer_id=$2', [m.accountNumber, f.customer_id]));
    return tx(async (c) => {
      const dup = await maybe<any>(c, `SELECT id FROM bank_statement WHERE customer_id=$1 AND file_sha256=$2 AND status <> 'REJECTED'`, [f.customer_id, sha]);
      if (dup) throw conflict('DUPLICATE_STATEMENT', 'This exact statement file has already been uploaded.');
      const doc = await one<any>(c, `INSERT INTO document(customer_id, facility_id, doc_type, title, status, mandatory) VALUES ($1,$2,'BANK_STATEMENT',$3,'UPLOADED',false) RETURNING *`, [f.customer_id, f.id, `${m.bankName} statement ${maskAccount(m.accountNumber)} (${m.periodStart} – ${m.periodEnd})`]);
      const { version } = await storeVersion(c, actor, { documentId: doc.id, buffer, filename, declaredMime: mimetype, acceptedMime: [MIME.CSV, MIME.XLSX, MIME.PDF], maxSizeMb: 20, metadata: { ...m, ...(spooledFrom ? { source: `CBA_${spooledFrom}` } : {}) }, facilityId: f.id, customerId: f.customer_id });
      await q(c, 'UPDATE document SET current_version_id=$2 WHERE id=$1', [doc.id, version.id]);
      const s = await one<any>(c, `INSERT INTO bank_statement(customer_id, facility_id, document_version_id, bank_name, is_alternative_bank, account_number, currency, period_start, period_end, file_sha256, uploaded_by_type, uploaded_by_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [f.customer_id, f.id, version.id, m.bankName, altBank, m.accountNumber, m.currency, m.periodStart, m.periodEnd, sha, actor.type, actor.id]);
      await enqueue(c, 'statement.parse', { statementId: s.id }, { idempotencyKey: `parse:${s.id}` });
      await audit(c, actor, { action: spooledFrom ? 'STATEMENT_SPOOLED' : 'STATEMENT_UPLOADED', entityType: 'bank_statement', entityId: s.id, facilityId: f.id, customerId: f.customer_id, metadata: { bank: m.bankName, account: maskAccount(m.accountNumber), currency: m.currency, ...(spooledFrom ? { source: spooledFrom } : {}) } });
      return s;
    });
  }

  /** The customer's own Alternative Bank accounts, for choosing a statement to spool. */
  app.get('/api/facilities/:id/altbank-accounts', async (req, reply) => {
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    return ok(reply, await q(db, 'SELECT account_number AS "accountNumber", account_name AS "accountName", currency, product_name AS product FROM customer_account WHERE customer_id=$1 ORDER BY is_primary DESC, account_number', [f.customer_id]));
  });

  app.get('/api/facilities/:id/bank-statements', async (req, reply) => {
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    // Statements belong to the customer and are reused across requests (never re-requested).
    const rows = await q(db, 'SELECT * FROM bank_statement WHERE customer_id=$1 ORDER BY bank_name, account_number, period_start', [f.customer_id]);
    return ok(reply, rows.map(statementView));
  });

  app.get('/api/bank-statements/:sid/transactions', async (req, reply) => {
    requireStaff(req, 'financials.edit');
    const { sid } = parse(z.object({ sid: z.uuid() }), req.params);
    const { uncertainOnly } = parse(z.object({ uncertainOnly: z.coerce.boolean().default(false) }), req.query);
    const s = await maybe<any>(db, 'SELECT * FROM bank_statement WHERE id=$1', [sid]);
    if (!s) throw notFound('Statement');
    await loadFacility(db, req, s.facility_id);
    const rows = await q(db, `SELECT id, line_no AS "lineNo", txn_date AS date, description_raw AS description, category, debit_minor AS "debitMinor", credit_minor AS "creditMinor", balance_minor AS "balanceMinor", uncertain, uncertain_reason AS "uncertainReason", corrected_at AS "correctedAt"
      FROM bank_transaction WHERE statement_id=$1 ${uncertainOnly ? 'AND uncertain' : ''} ORDER BY line_no LIMIT 2000`, [sid]);
    return ok(reply, rows);
  });

  /** Human validation of an uncertain transaction. Original raw description is retained. */
  app.patch('/api/bank-transactions/:tid', async (req, reply) => {
    requireStaff(req, 'financials.edit');
    const { tid } = parse(z.object({ tid: z.uuid() }), req.params);
    const b = parse(z.object({ txnDate: z.iso.date(), debitMinor: z.number().int().min(0), creditMinor: z.number().int().min(0), balanceMinor: z.number().int().nullable(), reason: z.string().trim().min(5).max(500) }), req.body);
    const t = await maybe<any>(db, 'SELECT t.*, s.facility_id, s.customer_id, s.status FROM bank_transaction t JOIN bank_statement s ON s.id=t.statement_id WHERE t.id=$1', [tid]);
    if (!t) throw notFound('Transaction');
    await loadFacility(db, req, t.facility_id);
    if (t.status === 'VALIDATED') throw conflict('VALIDATED', 'This statement has been validated.');
    await tx(async (c) => {
      await q(c, `UPDATE bank_transaction SET txn_date=$2, debit_minor=$3, credit_minor=$4, balance_minor=$5, uncertain=false, uncertain_reason=NULL, corrected_by=$6, corrected_at=now() WHERE id=$1`, [tid, b.txnDate, b.debitMinor, b.creditMinor, b.balanceMinor, req.auth!.subjectId]);
      await q(c, `UPDATE bank_statement SET uncertain_count=(SELECT count(*) FROM bank_transaction WHERE statement_id=$1 AND uncertain) WHERE id=$1`, [t.statement_id]);
      await audit(c, actorOf(req), { action: 'TRANSACTION_CORRECTED', entityType: 'bank_transaction', entityId: tid, facilityId: t.facility_id, customerId: t.customer_id, before: { date: t.txn_date, debit: t.debit_minor, credit: t.credit_minor, balance: t.balance_minor }, after: b });
    });
    return ok(reply, { corrected: true });
  });

  app.post('/api/bank-statements/:sid/review', async (req, reply) => {
    requireStaff(req, 'financials.validate');
    const { sid } = parse(z.object({ sid: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['VALIDATED', 'REJECTED']), note: z.string().trim().max(1000).optional() }), req.body);
    const s = await maybe<any>(db, 'SELECT * FROM bank_statement WHERE id=$1', [sid]);
    if (!s) throw notFound('Statement');
    await loadFacility(db, req, s.facility_id);
    if (b.decision === 'VALIDATED' && s.uncertain_count > 0) throw unprocessable('UNCERTAIN', 'Resolve the uncertain transactions before validating.');
    if (b.decision === 'VALIDATED' && !['PARSED', 'NEEDS_REVIEW'].includes(s.status)) throw conflict('STATE', 'Only parsed statements can be validated.');
    await q(db, 'UPDATE bank_statement SET status=$2, validated_by=$3, validated_at=now() WHERE id=$1', [sid, b.decision, req.auth!.subjectId]);
    await audit(db, actorOf(req), { action: `STATEMENT_${b.decision}`, entityType: 'bank_statement', entityId: sid, facilityId: s.facility_id, customerId: s.customer_id, metadata: { note: b.note } });
    return ok(reply, { status: b.decision });
  });

  app.post('/api/facilities/:id/statement-analysis', async (req, reply) => {
    requireStaff(req, 'financials.validate');
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    const stmts = await q<any>(db, `SELECT * FROM bank_statement WHERE customer_id=$1 AND status IN ('PARSED','NEEDS_REVIEW','VALIDATED')`, [f.customer_id]);
    if (!stmts.length) throw unprocessable('NO_STATEMENTS', 'No parsed bank statements are available.');
    const txns = await q<any>(db, 'SELECT * FROM bank_transaction WHERE statement_id = ANY($1)', [stmts.map((s) => s.id)]);
    const rates = await q<any>(db, `SELECT * FROM fx_rate WHERE quote_ccy='NGN' ORDER BY rate_date DESC`);
    const res = analyseStatements(stmts, txns, (ccy, monthEnd) => rates.find((r) => r.base_ccy === ccy && r.rate_date <= monthEnd) ?? null);
    const pendingValidation = stmts.filter((s) => s.status !== 'VALIDATED').length;
    if (pendingValidation) res.issues.push({ severity: 'WARNING', message: `${pendingValidation} statement(s) have not yet been validated by a human; results are provisional.` });
    const actor = actorOf(req);
    const a = await tx(async (c) => {
      const row = await one<any>(c, `INSERT INTO statement_analysis(facility_id, statement_ids, fx_rate_ids, summary, monthly, issues, run_by_type, run_by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [f.id, stmts.map((s) => s.id), res.fxRates.map((r) => r.id), JSON.stringify(res.summary), JSON.stringify({ byAccount: res.monthly.map((m) => ({ ...m, account: maskAccount(m.account) })), totals: res.totals }), JSON.stringify(res.issues), actor.type, actor.id]);
      await audit(c, actor, { action: 'STATEMENT_ANALYSIS_RUN', entityType: 'statement_analysis', entityId: row.id, facilityId: f.id, metadata: { months: res.summary.monthsCovered, fxRates: res.fxRates.map((r) => ({ id: r.id, rate: r.rate, date: r.rate_date })) } });
      return row;
    });
    return ok(reply, { id: a.id, runAt: a.created_at, summary: res.summary, monthly: a.monthly, issues: res.issues, fxRates: res.fxRates }, 201);
  });

  app.get('/api/facilities/:id/statement-analysis', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    const a = await maybe<any>(db, 'SELECT * FROM statement_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [f.id]);
    if (!a) return ok(reply, null);
    const fx = a.fx_rate_ids.length ? await q(db, 'SELECT id, base_ccy, rate, rate_date, source FROM fx_rate WHERE id = ANY($1)', [a.fx_rate_ids]) : [];
    return ok(reply, { id: a.id, runAt: a.created_at, summary: a.summary, monthly: a.monthly, issues: a.issues, fxRates: fx });
  });
}
