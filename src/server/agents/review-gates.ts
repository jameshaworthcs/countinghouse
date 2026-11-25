// The gates a month in review must pass before a prompt version goes live (docs/AGENTS.md,
// "monthly-review"; scripts/review-eval.ts): read only from what the review wrote, so they cost
// nothing and are tested like any other code. Each says what it checks and what it found.

import type { Insight, ReviewAction } from '../../shared/schema';

export interface Gate {
  id: string;
  ok: boolean;
  detail: string;
}

/** Words the app uses for itself, never the owner's (the prompt bans them). */
const JARGON = /\b(nothing was scheduled|one-offs line|not placed|couldn[’']t be placed|accounts the app doesn[’']t know|oldValuation|completeData|categorisedBy)\b/i;
/** Capitals that are not a bank's description: the acronyms of UK money. */
const ACRONYMS = new Set(['ISA', 'LISA', 'SIPP', 'HMRC', 'PAYE', 'NI', 'NS&I', 'UK', 'GBP', 'BR', 'NT', 'P60', 'P45', 'P11D', 'ETF', 'GIA', 'APR', 'AER', 'FSCS', 'SA', 'TFL', 'DWP', 'SLC', 'AI', 'NHS', 'VAT', 'DD']);

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** A month in review against its gates: length, title, key points, plain words, whole pounds, actions. */
export function reviewGates(review: Insight, opts: { actions: ReviewAction[]; month: string; catchUp: boolean; alerts: string[]; openBefore: string[]; decidedBefore: string[]; cardsClean: string[] }): Gate[] {
  const parts = review.sections ?? [];
  const visible = [review.title, ...(review.keyPoints ?? []).map((k) => k.text), ...parts.map((x) => x.body)];
  const text = visible.join('\n');
  const total = visible.reduce((n, t) => n + words(t), 0);
  const pounds = [...text.matchAll(/£\s?[\d,]+(\.\d{1,2})?/g)];
  const pence = pounds.filter((m) => m[1]).length;
  const caps = [...text.matchAll(/\b[A-Z][A-Z&]{2,}(?:\s+[A-Z][A-Z&]{1,})+\b/g)].map((m) => m[0]).filter((m) => !m.split(/\s+/).every((w) => ACRONYMS.has(w)));
  const asked = opts.actions.filter((a) => a.lastMonth === opts.month && (review.actionKeys ?? []).includes(a.key));
  const covered = new Set(opts.actions.filter((a) => a.lastMonth === opts.month || a.closed?.month === opts.month).map((a) => a.key));
  const dropped = opts.openBefore.filter((k) => !covered.has(k));
  const cardWatch = (review.watch ?? []).filter((w) => /paid in full|cleared in full|direct debit/i.test(w));
  return [
    { id: 'length', ok: total <= 400, detail: `${total} words in the title, key points and parts (at most 400)` },
    { id: 'title', ok: review.title.length <= 95 && !/^[A-Z][a-z]+ \d{4}:|^(January|February|March|April|May|June|July|August|September|October|November|December):/.test(review.title), detail: `${review.title.length} characters: “${review.title}”` },
    { id: 'key-points', ok: (review.keyPoints?.length ?? 0) >= 1 && (review.keyPoints?.length ?? 0) <= 3 && (review.keyPoints ?? []).every((k) => words(k.text) <= 30), detail: `${review.keyPoints?.length ?? 0} key points, the longest ${Math.max(0, ...(review.keyPoints ?? []).map((k) => words(k.text)))} words` },
    { id: 'plain-words', ok: !JARGON.test(text), detail: JARGON.test(text) ? `the app’s words: “${JARGON.exec(text)![0]}”` : 'none of the app’s words' },
    { id: 'names', ok: caps.length === 0, detail: caps.length ? `in capitals: ${[...new Set(caps)].slice(0, 5).join(', ')}` : 'no bank descriptions in capitals' },
    { id: 'whole-pounds', ok: pounds.length === 0 || pence / pounds.length <= 0.2, detail: `${pence} of ${pounds.length} £ figures to the penny` },
    { id: 'unchecked', ok: !(review.unchecked?.length), detail: review.unchecked?.length ? `figures not found: ${review.unchecked.join(', ')}` : 'every figure found' },
    ...(opts.catchUp
      ? [{ id: 'written-later', ok: !(review.actionKeys?.length), detail: review.actionKeys?.length ? `asked ${review.actionKeys.length} action(s)` : 'no actions, as written later' }]
      : [
          { id: 'actions', ok: asked.length <= 3, detail: `${asked.length} asked: ${asked.map((a) => a.what).join('; ') || 'none'}` },
          { id: 'no-alert-repeated', ok: !(opts.alerts.some((id) => id.startsWith('sa-')) && asked.some((a) => /self.?assessment|tell hmrc|register/i.test(`${a.key} ${a.what}`))), detail: 'no action repeats a Self Assessment alert' },
          { id: 'open-carried', ok: dropped.length === 0, detail: dropped.length ? `open actions neither asked again nor dropped: ${dropped.join(', ')}` : `${opts.openBefore.length} open action(s) all asked again or dropped` },
          { id: 'decided-kept', ok: !asked.some((a) => opts.decidedBefore.includes(a.key)), detail: 'none you decided asked again' },
        ]),
    { id: 'no-routine-watch', ok: opts.cardsClean.length === 0 || cardWatch.length === 0, detail: cardWatch.length ? `watches a card: ${cardWatch[0]}` : 'no routine card line' },
  ];
}
