/** Payment schedule generation (pure). Profit for Murabaha/Ijarah-type contracts is fixed at inception. */
const STEP: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };

export function addMonths(iso: string, m: number) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + m);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function buildSchedule(input: { principalMinor: number; profitRatePct: number; tenorMonths: number; frequency: string; startDate: string; moratoriumMonths?: number; pricingBasis: string }) {
  const totalProfit = input.pricingBasis === 'NONE' || input.pricingBasis === 'FEE' ? 0 : Math.round(input.principalMinor * (input.profitRatePct / 100) * (input.tenorMonths / 12));
  const step = input.frequency === 'BULLET' ? input.tenorMonths : STEP[input.frequency] ?? 1;
  const mor = input.moratoriumMonths ?? 0;
  const n = Math.max(1, Math.floor((input.tenorMonths - mor) / step));
  const items: { seq: number; dueDate: string; principalMinor: number; profitMinor: number; totalMinor: number }[] = [];
  let pLeft = input.principalMinor, prLeft = totalProfit;
  for (let i = 1; i <= n; i++) {
    const p = i === n ? pLeft : Math.round(input.principalMinor / n);
    const pr = i === n ? prLeft : Math.round(totalProfit / n);
    pLeft -= p; prLeft -= pr;
    items.push({ seq: i, dueDate: addMonths(input.startDate, mor + i * step), principalMinor: p, profitMinor: pr, totalMinor: p + pr });
  }
  return { items, totalProfit, maturityDate: addMonths(input.startDate, input.tenorMonths) };
}
