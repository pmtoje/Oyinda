/**
 * AI safety guard: prompt-injection defence for untrusted text and output validation.
 * Pure functions so they can be unit-tested exhaustively.
 */
export interface Source { id: string; label: string; value: string; ref: { table: string; id: string }; untrusted?: boolean }
export interface Claim { text: string; sourceIds: string[] }

const INJECTION_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i, 'instruction override'],
  [/disregard\s+(the\s+)?(system|previous|above)/i, 'instruction override'],
  [/\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\s+to\s+be\b/i, 'role reassignment'],
  [/\b(system|assistant|developer)\s*:/i, 'role marker'],
  [/<\/?\s*(system|instructions?|sources?|prompt)\s*>/i, 'delimiter spoofing'],
  [/\b(approve|recommend approval of|grant)\s+(this|the)\s+(facility|request|loan)\b/i, 'decision steering'],
  [/\b(reveal|print|output|show)\s+(your|the)\s+(system\s+prompt|instructions|api\s*key|secrets?)\b/i, 'exfiltration attempt'],
  [/https?:\/\/[^\s]+/i, 'embedded URL'],
];

/** Neutralise untrusted text (customer-entered descriptions, document extracts) before it reaches a model. */
export function sanitiseUntrusted(text: string, maxLen = 2000) {
  const flags: string[] = [];
  // Strips control, zero-width and bidi-override characters used to hide instructions (deliberate control-character regex).
  // eslint-disable-next-line no-control-regex
  let t = text.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  for (const [re, label] of INJECTION_PATTERNS) if (re.test(t)) flags.push(label);
  t = t.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).replace(/https?:\/\/[^\s]+/gi, '[link removed]');
  if (t.length > maxLen) { t = t.slice(0, maxLen) + ' [truncated]'; flags.push('truncated'); }
  return { text: t, flags: [...new Set(flags)] };
}

const DECISION_LANGUAGE = /\b(i|we)\s+(approve|decline|reject)\b|\bthe\s+facility\s+(is|should\s+be)\s+(approved|declined)\b|\b(approve|decline)\s+this\s+(facility|request)\b|\brecommend(s|ed)?\s+(approval|decline|declining|approving)\b/i;
const numbersIn = (s: string) => (s.match(/-?\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '')).filter((n) => n.replace(/[-.]/g, '').length >= 2);

/**
 * Every claim must cite known sources, every number it states must appear in those sources,
 * and the assistant may not make or steer a credit decision. Failing claims are removed, not repaired.
 */
export function validateClaims(claims: Claim[], sources: Source[]) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const accepted: Claim[] = [];
  const rejected: { claim: Claim; reason: string }[] = [];
  for (const c of claims) {
    const cited = c.sourceIds.map((id) => byId.get(id)).filter(Boolean) as Source[];
    if (!c.sourceIds.length || cited.length !== c.sourceIds.length) { rejected.push({ claim: c, reason: 'Cites no source or an unknown source' }); continue; }
    if (DECISION_LANGUAGE.test(c.text)) { rejected.push({ claim: c, reason: 'AI may not make or recommend a credit decision' }); continue; }
    const haystack = cited.map((s) => `${s.label} ${s.value}`).join(' ').replace(/,/g, '');
    const unsupported = numbersIn(c.text).filter((n) => !haystack.includes(n.replace(/^-/, '')));
    if (unsupported.length) { rejected.push({ claim: c, reason: `Figures not found in cited sources: ${unsupported.join(', ')}` }); continue; }
    accepted.push(c);
  }
  return { accepted, rejected, ok: rejected.length === 0 };
}
