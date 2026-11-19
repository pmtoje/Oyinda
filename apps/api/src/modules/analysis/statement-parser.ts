import { createHash } from 'node:crypto';

export interface ParsedTxn {
  lineNo: number; txnDate: string | null; valueDate: string | null; descriptionRaw: string; descriptionNorm: string; category: string;
  debitMinor: number; creditMinor: number; balanceMinor: number | null; uncertain: boolean; uncertainReason: string | null; fingerprint: string;
}
export interface ParseResult { ok: boolean; parser: string; detectedAccountNumber: string | null; transactions: ParsedTxn[]; issues: string[] }

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

export function parseDate(raw: unknown): string | null {
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) { d = +r[1]!; m = +r[2]!; y = +r[3]!; } // Nigerian banks: day first
  else if ((r = /^(\d{1,2})[\s/-]([A-Z]{3,4})[\s/-](\d{2,4})$/.exec(s))) { d = +r[1]!; m = MONTHS[r[2]!] ?? 0; y = +r[3]!; }
  else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** Parse an amount to minor units. Returns null when ambiguous rather than guessing. */
export function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = String(raw).trim().toUpperCase().replace(/[₦$\s]|NGN|USD/g, '');
  if (s === '' || s === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('DR')) { neg = true; s = s.slice(0, -2); } else if (s.endsWith('CR')) s = s.slice(0, -2);
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s.replace(/,/g, '')) * 100);
  return neg ? -v : v;
}

export function normaliseDescription(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9 /&.-]/g, ' ').replace(/\b\d{6,}\b/g, '#').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function categorise(norm: string, credit: number): string {
  if (/REVERSAL|RVSL|REVERSED/.test(norm)) return 'REVERSAL';
  if (/\b(VAT|STAMP DUTY|SMS ALERT|CHARGE|COMMISSION|COT|MAINTENANCE FEE|FEE)\b/.test(norm)) return 'CHARGES';
  if (/\bPOS\b/.test(norm)) return 'POS';
  if (/\b(SALARY|PAYROLL)\b/.test(norm)) return 'PAYROLL';
  if (/\b(TAX|FIRS|LIRS|WHT|PAYE)\b/.test(norm)) return 'TAX';
  if (/\b(CASH DEP|CASH DEPOSIT|LODGEMENT)\b/.test(norm)) return 'CASH_DEPOSIT';
  if (/\b(CASH WDL|CASH WITHDRAWAL|ATM)\b/.test(norm)) return 'CASH_WITHDRAWAL';
  if (/\b(MURABAHA|IJARAH|FACILITY REPAY|LOAN REPAY|REPAYMENT)\b/.test(norm)) return 'FINANCING_PAYMENT';
  if (/\b(NIP|TRF|TRANSFER|NEFT|RTGS|FT)\b/.test(norm)) return credit > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
  return credit > 0 ? 'OTHER_CREDIT' : 'OTHER_DEBIT';
}

const HEAD = {
  date: /^(trans(action)?\.? ?date|txn ?date|date|posting date|tran date)$/i,
  value: /^(value ?date|val ?date)$/i,
  desc: /^(description|narration|narrative|details|remarks|particulars|transaction details)$/i,
  debit: /^(debit|debits|withdrawal|withdrawals|dr|debit amount|money out)$/i,
  credit: /^(credit|credits|deposit|deposits|lodgement|cr|credit amount|money in)$/i,
  amount: /^(amount|transaction amount)$/i,
  balance: /^(balance|running balance|closing balance|bal|available balance)$/i,
};

/** Parse a tabular statement (rows already split into cells). */
export function parseRows(rows: unknown[][], parser: string): ParseResult {
  const issues: string[] = [];
  let detectedAccount: string | null = null;
  let headerIdx = -1;
  let cols: Partial<Record<keyof typeof HEAD, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i]!.map((c) => String(c ?? '').trim());
    const acct = row.join(' ').match(/\b(\d{10})\b/);
    if (acct && !detectedAccount && !row.some((c) => HEAD.date.test(c))) detectedAccount = acct[1]!;
    const found: typeof cols = {};
    row.forEach((c, idx) => { for (const [k, re] of Object.entries(HEAD)) if (re.test(c) && found[k as keyof typeof HEAD] === undefined) found[k as keyof typeof HEAD] = idx; });
    if (found.date !== undefined && found.desc !== undefined && (found.debit !== undefined || found.credit !== undefined || found.amount !== undefined)) { headerIdx = i; cols = found; break; }
  }
  if (headerIdx < 0) return { ok: false, parser, detectedAccountNumber: detectedAccount, transactions: [], issues: ['Could not identify the date, description and amount columns. The statement needs manual capture or OCR processing.'] };
  const txns: ParsedTxn[] = [];
  let prevBal: number | null = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const cell = (k: keyof typeof HEAD) => (cols[k] === undefined ? undefined : r[cols[k]!]);
    const desc = String(cell('desc') ?? '').trim();
    const rawDate = cell('date');
    if (!desc && (rawDate === undefined || String(rawDate).trim() === '')) continue;
    if (/^(opening|closing|brought forward|b\/f|c\/f|total)/i.test(desc) && !String(rawDate ?? '').trim()) continue;
    const reasons: string[] = [];
    const date = parseDate(rawDate);
    if (!date) reasons.push('Unreadable transaction date');
    let debit = 0, credit = 0;
    if (cols.amount !== undefined && cols.debit === undefined && cols.credit === undefined) {
      const a = parseAmount(cell('amount'));
      if (a === null) reasons.push('Unreadable amount'); else if (a < 0) debit = -a; else credit = a;
    } else {
      const d = parseAmount(cell('debit')); const c = parseAmount(cell('credit'));
      if (d === null || c === null) reasons.push('Unreadable amount');
      debit = Math.abs(d ?? 0); credit = Math.abs(c ?? 0);
      if (debit > 0 && credit > 0) reasons.push('Both debit and credit populated');
    }
    const balRaw = cell('balance');
    const bal = balRaw === undefined || balRaw === '' ? null : parseAmount(balRaw);
    if (balRaw !== undefined && balRaw !== '' && bal === null) reasons.push('Unreadable balance');
    if (bal !== null && prevBal !== null && Math.abs(prevBal + credit - debit - bal) > 1) reasons.push('Running balance does not reconcile with the previous line');
    if (bal !== null) prevBal = bal;
    const norm = normaliseDescription(desc || '(no description)');
    txns.push({
      lineNo: i + 1, txnDate: date, valueDate: parseDate(cell('value')), descriptionRaw: desc.slice(0, 1000) || '(no description)', descriptionNorm: norm, category: categorise(norm, credit),
      debitMinor: debit, creditMinor: credit, balanceMinor: bal, uncertain: reasons.length > 0, uncertainReason: reasons.join('; ') || null,
      fingerprint: createHash('sha256').update(`${date}|${debit}|${credit}|${bal}|${norm}`).digest('hex').slice(0, 32),
    });
  }
  if (!txns.length) issues.push('No transactions were found below the header row.');
  const unc = txns.filter((t) => t.uncertain).length;
  if (unc) issues.push(`${unc} transaction(s) could not be read with certainty and need human validation.`);
  return { ok: txns.length > 0, parser, detectedAccountNumber: detectedAccount, transactions: txns, issues };
}

/** RFC 4180-style CSV splitting (quoted fields, embedded commas/quotes). */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function parseStatementFile(buf: Buffer, mime: string): Promise<ParseResult> {
  if (mime === 'text/csv') return parseRows(splitCsv(buf.toString('utf8').replace(/^﻿/, '')), 'csv-v1');
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    if (!ws) return { ok: false, parser: 'xlsx-v1', detectedAccountNumber: null, transactions: [], issues: ['The workbook has no worksheets.'] };
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => { rows.push((r.values as unknown[]).slice(1).map((v: any) => (v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'richText' in v ? v.richText.map((x: any) => x.text).join('') : v))); });
    return parseRows(rows, 'xlsx-v1');
  }
  return { ok: false, parser: 'none', detectedAccountNumber: null, transactions: [], issues: ['PDF and image statements require OCR. The OCR adapter is not provisioned in this environment, so this statement must be validated manually or re-uploaded as CSV/XLSX from internet banking.'] };
}
