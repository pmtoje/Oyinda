import type { Db } from '../../db/pool.js';
import { maybe } from '../../db/pool.js';
import { conflict } from '../../lib/errors.js';
import { convertMinor } from '../../lib/money.js';

export interface FxRateRow { id: string; base_ccy: string; quote_ccy: string; rate: number; rate_date: string; source: string }

/** Latest auditable rate on or before `asOf`. Never invents a rate. */
export async function rateFor(db: Db, base: string, quote = 'NGN', asOf: string | Date = new Date()): Promise<FxRateRow | null> {
  if (base === quote) return null;
  return (await maybe<FxRateRow>(db, `SELECT * FROM fx_rate WHERE base_ccy=$1 AND quote_ccy=$2 AND rate_date <= $3::date ORDER BY rate_date DESC, created_at DESC LIMIT 1`, [base, quote, asOf])) ?? null;
}

export async function toNgn(db: Db, minor: number, ccy: string, asOf?: string | Date): Promise<{ minor: number; rate: FxRateRow | null }> {
  if (ccy === 'NGN') return { minor, rate: null };
  const r = await rateFor(db, ccy, 'NGN', asOf);
  if (!r) throw conflict('FX_RATE_MISSING', `No approved ${ccy}/NGN rate is available. An administrator must record one before this value can be converted.`);
  return { minor: convertMinor(minor, r.rate), rate: r };
}
