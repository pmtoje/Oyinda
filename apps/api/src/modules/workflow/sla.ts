/**
 * SLA time arithmetic. Business-hour calendars (working days, hours, public holidays, timezone offset)
 * come from configuration; nothing here is hard-coded to a particular schedule.
 */
export interface Calendar { timezoneOffsetMinutes: number; workdays: number[]; startHour: number; endHour: number; holidays: string[] }
const H = 3600_000;

const local = (t: number, cal: Calendar) => new Date(t + cal.timezoneOffsetMinutes * 60_000);
const isWorkday = (d: Date, cal: Calendar) => cal.workdays.includes(d.getUTCDay()) && !cal.holidays.includes(d.toISOString().slice(0, 10));

/** Add `hours` of working time to `start`. */
export function addBusinessHours(start: Date, hours: number, cal: Calendar): Date {
  let remaining = hours * H;
  let t = start.getTime();
  for (let guard = 0; guard < 5000 && remaining > 0; guard++) {
    const l = local(t, cal);
    const dayStart = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), cal.startHour) - cal.timezoneOffsetMinutes * 60_000;
    const dayEnd = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), cal.endHour) - cal.timezoneOffsetMinutes * 60_000;
    if (!isWorkday(l, cal) || t >= dayEnd) { t = dayStart + 24 * H; continue; }
    if (t < dayStart) t = dayStart;
    const avail = dayEnd - t;
    if (remaining <= avail) return new Date(t + remaining);
    remaining -= avail;
    t = dayStart + 24 * H;
  }
  return new Date(t);
}

/** Working milliseconds between two instants. */
export function businessMsBetween(a: Date, b: Date, cal: Calendar): number {
  if (b <= a) return 0;
  let total = 0;
  let t = a.getTime();
  const end = b.getTime();
  for (let guard = 0; guard < 5000 && t < end; guard++) {
    const l = local(t, cal);
    const dayStart = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), cal.startHour) - cal.timezoneOffsetMinutes * 60_000;
    const dayEnd = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), cal.endHour) - cal.timezoneOffsetMinutes * 60_000;
    const next = dayStart + 24 * H;
    if (isWorkday(l, cal)) total += Math.max(0, Math.min(end, dayEnd) - Math.max(t, dayStart));
    t = next;
  }
  return total;
}

export function computeDue(start: Date, policy: { durationHours: number; calendar: 'BUSINESS' | 'CALENDAR'; warnAtPct: number }, cal: Calendar) {
  if (policy.calendar === 'CALENDAR') {
    return { dueAt: new Date(start.getTime() + policy.durationHours * H), warnAt: new Date(start.getTime() + policy.durationHours * H * (policy.warnAtPct / 100)) };
  }
  return { dueAt: addBusinessHours(start, policy.durationHours, cal), warnAt: addBusinessHours(start, policy.durationHours * (policy.warnAtPct / 100), cal) };
}
