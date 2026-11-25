// The gate for a new month-in-review prompt (docs/AGENTS.md, "monthly-review"): write a month's
// review again on a copy of the data, and show it beside the review that stands, with the automated
// gates (src/server/agents/review-gates.ts) for you to judge before the real month runs.
//
//   npm run review:eval -- 2026-09                  September again, as the latest month (actions, today's figures)
//   npm run review:eval -- 2026-08 --catch-up       as written later, at the month's end
//   npm run review:eval -- 2026-09 --dry-run        build what Claude would read, show the prompt, stop: free
//   npm run review:eval -- 2026-09 --model sonnet   another Claude model for this run (default: Settings → Models)
//   npm run review:eval -- 2026-10 --scenario sa    demo data only: dividends last year over the allowance, nothing told
//   npm run review:eval -- 2026-10 --scenario actions   demo data only: an action left open, one you decided
//
// It copies the data directory (FINANCE_DATA_DIR, else data/; its documents left out) into a
// throwaway directory deleted afterwards: the data itself, the live app, its jobs and its sessions
// are never touched. Every run but --dry-run is a Claude run on your plan (about $0.40 to $1); it
// starts only because you ran this. Output stays in the terminal and the work area
// (`.work/review-eval/`), never in git: a review of real data is about your money.

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyReviewActions, decideAction } from '../src/server/actions';
import { buildMonthDigest } from '../src/server/agents/digest';
import { JobRunner } from '../src/server/agents/jobs';
import { JOB_DEFS } from '../src/server/agents/kinds';
import { reviewGates } from '../src/server/agents/review-gates';
import { Analytics } from '../src/server/analytics';
import { loadConfig, loadDotEnv } from '../src/server/config';
import { transactionId } from '../src/server/ids';
import { ProposalService } from '../src/server/proposals';
import { Store } from '../src/server/store';
import { addMonths, today } from '../src/shared/dates';
import { taxYearOf } from '../src/shared/uk';

loadDotEnv();

const VERSION = JOB_DEFS['monthly-review'].promptVersion;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const month = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  if (!month) throw new Error('Name a month: npm run review:eval -- 2026-09');
  const catchUp = args.includes('--catch-up');
  const dryRun = args.includes('--dry-run');
  const model = opt('model');
  const scenario = opt('scenario');
  const config = loadConfig();
  if (scenario && !/demo/.test(path.basename(config.dataDir))) throw new Error('--scenario changes the copy it runs on: demo data only (FINANCE_DATA_DIR=demo-data).');

  // A copy of the data: a Store opened on the data itself could write to it (start-up upkeep).
  const scratch = await mkdtemp(path.join(config.workDir, '..', 'review-eval-'));
  const dataCopy = path.join(scratch, 'data');
  await cp(config.dataDir, dataCopy, { recursive: true, filter: (src) => path.relative(config.dataDir, src).split(path.sep)[0] !== 'documents' });
  const store = await Store.open(dataCopy);
  try {
    if (scenario === 'sa') await scenarioSa(store);
    else if (scenario === 'actions') await scenarioActions(store, month);
    else if (scenario) throw new Error(`Unknown scenario ${scenario}: sa, actions`);
    if (model) await store.setSettings({ ...store.settings, models: { ...store.settings.models, tasks: { ...store.settings.models.tasks, 'monthly-review': { engine: 'claude-cli', model } } } });

    const analytics = new Analytics(store);
    const standing = store.insights.find((i) => i.kind === 'month-review' && i.subject.month === month && i.status === 'active');
    const digest = buildMonthDigest(store, analytics, { month, catchUp });
    const before = { open: digest.actions?.open.map((a) => a.key) ?? [], decided: digest.actions?.decided.map((a) => a.key) ?? [], alerts: digest.asOfToday?.alertsShown.map((a) => a.id) ?? [] };
    const cardsClean = digest.cards.filter((c) => c.interestCharged12m === 0).map((c) => c.accountId);
    console.log(`━━ ${month}${catchUp ? ', written later' : ', as the latest month'} on ${VERSION}: the digest is ${Math.round(JSON.stringify(digest).length / 1024)} KB`);
    console.log(`   Verdict inputs: ${JSON.stringify(digest.verdictInputs)}`);
    console.log(`   Alerts shown: ${before.alerts.join(', ') || 'none'}; open actions: ${before.open.join(', ') || 'none'}; decided: ${before.decided.join(', ') || 'none'}`);
    if (standing) console.log(`   The review that stands (${standing.provenance.promptVersion}): “${standing.title}”, ${words(standing)} words`);

    if (dryRun) {
      const dir = path.join(scratch, 'dry');
      await mkdir(dir, { recursive: true });
      const prompt = await JOB_DEFS['monthly-review'].prepare({ store, analytics, params: { month, ...(catchUp ? { catchUp: true } : {}) }, scratch: dir });
      console.log(`\n${prompt}\n\n(dry run: nothing sent to Claude)`);
      return 0;
    }

    const workDir = path.join(scratch, 'work');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const proposals = ProposalService.forWorkDir(store, workDir);
    await proposals.init();
    const runner = new JobRunner(store, analytics, { ...config, workDir }, { autoRun: false, proposals });
    await runner.init();
    const started = Date.now();
    const job = runner.enqueue({ kind: 'monthly-review', params: { month, ...(catchUp ? { catchUp: true } : {}) }, trigger: 'owner' });
    if (!job) throw new Error('The job was not queued.');
    let now = runner.get(job.id)!;
    while (now.status === 'queued' || now.status === 'running') {
      await new Promise((r) => setTimeout(r, 2000));
      now = runner.get(job.id)!;
    }
    runner.stop();
    console.log(`\n   ${now.status} in ${Math.round((Date.now() - started) / 1000)} s${now.costUsd !== undefined ? `, $${now.costUsd}` : ''}${now.turns ? `, ${now.turns} turns` : ''}: ${now.summary ?? now.error ?? ''}`);
    const review = store.insights.find((i) => i.kind === 'month-review' && i.subject.month === month && i.status === 'active' && i.provenance.jobId === job.id);
    if (!review) return 1;
    print(review, store);
    const gates = reviewGates(review, { actions: store.actions, month, catchUp, alerts: before.alerts, openBefore: before.open, decidedBefore: before.decided, cardsClean });
    console.log('\n   Gates:');
    for (const g of gates) console.log(`     ${g.ok ? 'pass' : 'FAIL'}  ${g.id}: ${g.detail}`);
    const out = path.join(config.workDir, '..', 'review-eval');
    await mkdir(out, { recursive: true, mode: 0o700 });
    const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}_${month}_${VERSION}.json`);
    await writeFile(file, JSON.stringify({ month, catchUp, scenario: scenario ?? null, model: model ?? null, job: now, review, standing: standing ?? null, actions: store.actions, gates }, null, 1), { mode: 0o600 });
    console.log(`\nKept in ${file} (the copy of the data deleted). Judge it beside the one that stands: shorter, verdict first, and would you act on what it asks?`);
    return gates.every((g) => g.ok) ? 0 : 2;
  } finally {
    store.stopWatching();
    await rm(scratch, { recursive: true, force: true });
  }
}

const words = (r: { title: string; keyPoints?: { text: string }[] | undefined; sections?: { body: string }[] | undefined }) => [r.title, ...(r.keyPoints ?? []).map((k) => k.text), ...(r.sections ?? []).map((x) => x.body)].join(' ').split(/\s+/).filter(Boolean).length;

function print(review: Store['insights'][number], store: Store): void {
  console.log(`\n   ${review.title}   (${words(review)} words, ${review.confidence} confidence)`);
  const asked = store.actions.filter((a) => (review.actionKeys ?? []).includes(a.key));
  if (asked.length) {
    console.log('\n   What to do:');
    for (const a of asked) console.log(`     [${a.kind}] ${a.what}${a.by ? ` (by ${a.by})` : ''}${a.where ? ` → ${a.where}` : ''}\n       ${a.why}  {${a.key}}`);
  }
  const closed = store.actions.filter((a) => a.closed?.month === review.subject.month);
  for (const a of closed) console.log(`     dropped ${a.key}: ${a.closed!.reason}`);
  console.log('');
  (review.keyPoints ?? []).forEach((k, i) => console.log(`   ${i + 1}. ${k.text}`));
  for (const x of review.sections ?? []) console.log(`\n   ${x.heading}\n     ${x.body.replace(/\n/g, '\n     ')}`);
  if (review.watch?.length) console.log(`\n   To watch: ${review.watch.join(' | ')}`);
  for (const f of review.followUp ?? []) console.log(`   ${f.outcome}: ${f.watch}${f.note ? ` · ${f.note}` : ''}`);
  if (review.caveats?.length) console.log(`   Rests on: ${review.caveats.join(' | ')}`);
  if (review.proposals?.length) console.log(`   Proposed ${review.proposals.length} fix(es).`);
}

/** Demo only: last tax year's dividends over the allowance, and nothing told about Self Assessment. */
async function scenarioSa(store: Store): Promise<void> {
  const ty = taxYearOf(today());
  const day = `${ty.startYear - 1}-09-12`;
  const account = store.accounts.find((a) => a.type === 'current')!;
  const amount = 1_200;
  await store.addTransactions([{ id: transactionId(account.id, day, amount, 'EXAMPLE STUDIO LTD DIVIDEND', 0), accountId: account.id, date: day, amount, currency: 'GBP', description: 'EXAMPLE STUDIO LTD DIVIDEND', category: 'dividends', categorisedBy: 'user', source: {} }], 'review-eval: scenario sa');
  const { selfAssessment: _sa, ...profile } = store.profile;
  await store.setProfile(profile);
}

/** Demo only: an action from the month before left open, and one you decided not relevant. */
async function scenarioActions(store: Store, month: string): Promise<void> {
  const before = addMonths(`${month}-01`, -1).slice(0, 7);
  const account = store.accounts.find((a) => a.type === 'savings') ?? store.accounts[0]!;
  const provenance = { setBy: 'agent' as const, promptVersion: VERSION, jobId: 'job_review_eval' };
  await applyReviewActions(
    store,
    before,
    {
      actions: [
        { key: 'payee-example-gym-unused', what: 'Cancel the gym you have not used', why: 'Paid every month, no visits since the summer (scenario).', kind: 'money', where: 'spending' },
        { key: `acct-${account.id}-idle-cash`, what: 'Move idle cash to a better rate', why: 'A large balance at a low rate (scenario).', kind: 'money', where: 'accounts' },
      ],
      drops: [],
    },
    provenance,
  );
  await decideAction(store, `acct-${account.id}-idle-cash`, 'not-relevant', 'Kept there for the house deposit');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  },
);
