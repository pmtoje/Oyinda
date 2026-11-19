/** Minimal in-process Prometheus-format metrics registry. */
type Key = string;
const counters = new Map<Key, number>();
const durations = new Map<Key, { count: number; sum: number; buckets: number[] }>();
const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

export const metrics = {
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const k = `${name}${fmt(labels)}`;
    counters.set(k, (counters.get(k) ?? 0) + by);
  },
  observeRequest(route: string, method: string, status: number, ms: number) {
    this.inc('gazelle_http_requests_total', { route, method, status: String(status) });
    const k = `gazelle_http_request_duration_ms${fmt({ route, method })}`;
    const d = durations.get(k) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    d.count++; d.sum += ms;
    BUCKETS.forEach((b, i) => { if (ms <= b) d.buckets[i]!++; });
    durations.set(k, d);
  },
  snapshot() {
    const routes = [...durations.entries()].map(([k, d]) => ({ key: k, count: d.count, avgMs: d.count ? Math.round(d.sum / d.count) : 0, p95Bucket: BUCKETS.find((b, i) => d.buckets[i]! >= d.count * 0.95) ?? null }));
    return { counters: Object.fromEntries(counters), routes };
  },
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of counters) lines.push(`${k} ${v}`);
    for (const [k, d] of durations) {
      const base = k.replace(/\{.*$/, ''); const lbl = k.slice(base.length, -1);
      BUCKETS.forEach((b, i) => lines.push(`${base}_bucket${lbl},le="${b}"} ${d.buckets[i]}`));
      lines.push(`${base}_count${lbl}} ${d.count}`, `${base}_sum${lbl}} ${d.sum.toFixed(1)}`);
    }
    return lines.join('\n') + '\n';
  },
};
const fmt = (l: Record<string, string>) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`).join(',')}}` : '';
};
