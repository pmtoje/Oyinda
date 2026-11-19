/** Questionnaire scorecards (ORR / industry / collateral) and the combined rating. Pure functions. */
export interface Scorecard { kind: string; sections: { code: string; name: string; weight: number; questions: { code: string; text: string; options: { code: string; label: string; score: number }[] }[] }[]; grades: { grade: string; minScore: number; description: string }[] }

export function gradeFor<T extends { grade: string; minScore: number }>(score: number, grades: T[]): T {
  return [...grades].sort((a, b) => b.minScore - a.minScore).find((g) => score >= g.minScore) ?? [...grades].sort((a, b) => a.minScore - b.minScore)[0]!;
}

export function scoreQuestionnaire(card: Scorecard, answers: Record<string, string>) {
  const missing: string[] = [];
  const breakdown = card.sections.map((s) => {
    const qs = s.questions.map((q) => {
      const opt = q.options.find((o) => o.code === answers[q.code]);
      if (!opt) missing.push(q.code);
      const max = Math.max(...q.options.map((o) => o.score));
      return { code: q.code, text: q.text, answer: opt?.code ?? null, answerLabel: opt?.label ?? null, score: opt?.score ?? null, max };
    });
    const answered = qs.filter((q) => q.score !== null);
    const pct = answered.length ? (answered.reduce((a, q) => a + q.score!, 0) / answered.reduce((a, q) => a + q.max, 0)) * 100 : 0;
    return { code: s.code, name: s.name, weight: s.weight, scorePct: Math.round(pct * 100) / 100, questions: qs };
  });
  const tw = breakdown.reduce((a, s) => a + s.weight, 0);
  const score = tw ? Math.round((breakdown.reduce((a, s) => a + s.scorePct * s.weight, 0) / tw) * 100) / 100 : 0;
  const g = gradeFor(score, card.grades);
  return { score, grade: g.grade, gradeDescription: g.description, breakdown, missing };
}

export function combinedRating(model: { components: { kind: string; weight: number }[]; grades: { grade: string; minScore: number; description: string; riskLevel: string }[] }, scores: Record<string, number | undefined>) {
  const missing = model.components.filter((c) => scores[c.kind] === undefined).map((c) => c.kind);
  const tw = model.components.reduce((a, c) => a + c.weight, 0);
  const score = Math.round((model.components.reduce((a, c) => a + (scores[c.kind] ?? 0) * c.weight, 0) / tw) * 100) / 100;
  const g = gradeFor(score, model.grades);
  return { score, grade: g.grade, description: g.description, riskLevel: g.riskLevel, missing, components: model.components.map((c) => ({ ...c, score: scores[c.kind] ?? null })) };
}

/** Suggested collateral-coverage answer from the system-computed coverage. */
export const coverageOption = (pct: number) => (pct >= 150 ? 'GE150' : pct >= 100 ? '100_150' : pct >= 50 ? '50_100' : 'LT50');

export interface ExposureLine { reference: string; product: string; kind: 'DIRECT' | 'CONTINGENT'; outstandingMinor: number; approvedMinor: number; relatedParty?: string; source: string }

/** Aggregate exposure (NGN minor). Contingents are weighted by the configured credit conversion factor. */
export function aggregateExposure(input: { own: ExposureLine[]; group: ExposureLine[]; pipeline: ExposureLine[]; proposedMinor: number; proposedIsContingent: boolean; ccfPct: number; solLimitMinor: number }) {
  const ccf = input.ccfPct / 100;
  const weight = (l: ExposureLine) => (l.kind === 'CONTINGENT' ? Math.round(l.outstandingMinor * ccf) : l.outstandingMinor);
  const direct = input.own.filter((l) => l.kind === 'DIRECT').reduce((a, l) => a + l.outstandingMinor, 0) + input.pipeline.filter((l) => l.kind === 'DIRECT').reduce((a, l) => a + l.outstandingMinor, 0);
  const contingent = [...input.own, ...input.pipeline].filter((l) => l.kind === 'CONTINGENT').reduce((a, l) => a + weight(l), 0);
  const group = input.group.reduce((a, l) => a + weight(l), 0);
  const proposed = input.proposedIsContingent ? Math.round(input.proposedMinor * ccf) : input.proposedMinor;
  const aggregate = direct + contingent + group + proposed;
  return { direct, contingent, group, proposed, aggregate, solLimit: input.solLimitMinor, breached: aggregate > input.solLimitMinor, headroom: input.solLimitMinor - aggregate, maxSupportableMinor: Math.max(0, input.solLimitMinor - (direct + contingent + group)) };
}
