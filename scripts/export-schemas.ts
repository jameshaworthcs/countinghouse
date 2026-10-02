// Export JSON Schemas for every file under data/ into schemas/, generated from the Zod schemas in
// src/shared/schema.ts. Editors use them (accounts.json etc. carry a "$schema" pointer), and any
// other tool can validate the data with them.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../src/server/config';
import {
  AccountsFileSchema,
  AssumptionSchema,
  BalanceSnapshotSchema,
  BudgetsFileSchema,
  CaptureFileSchema,
  ContextSchema,
  CategoriesFileSchema,
  CsvProfilesFileSchema,
  FigureSchema,
  GoalsFileSchema,
  HoldingsSnapshotSchema,
  ImportRecordSchema,
  InsightSchema,
  InstitutionsFileSchema,
  InstrumentsFileSchema,
  EmploymentsFileSchema,
  AgreementsFileSchema,
  CoverageFileSchema,
  CompaniesFileSchema,
  HmrcRecordSchema,
  PayslipRecordSchema,
  TermsSchema,
  MetaSchema,
  NoteSchema,
  ProfileSchema,
  ProposalSchema,
  ReceiptSchema,
  ResearchSchema,
  RulesFileSchema,
  SettingsSchema,
  TransactionSchema,
} from '../src/shared/schema';

const out = path.join(PROJECT_ROOT, 'schemas');
const withSchemaKey = <T extends z.ZodObject>(s: T) => s.extend({ $schema: z.string().optional() });
const schemas: [string, z.ZodType, string][] = [
  ['meta', MetaSchema, 'data/meta.json'],
  ['profile', ProfileSchema, 'data/profile.json'],
  ['settings', SettingsSchema, 'data/settings.json'],
  ['accounts', withSchemaKey(AccountsFileSchema), 'data/accounts.json'],
  ['institutions', withSchemaKey(InstitutionsFileSchema), 'data/institutions.json'],
  ['categories', withSchemaKey(CategoriesFileSchema), 'data/categories.json'],
  ['rules', withSchemaKey(RulesFileSchema), 'data/rules.json'],
  ['goals', withSchemaKey(GoalsFileSchema), 'data/goals.json'],
  ['budgets', withSchemaKey(BudgetsFileSchema), 'data/budgets.json'],
  ['capture', withSchemaKey(CaptureFileSchema), 'data/capture.json'],
  ['csv-profiles', withSchemaKey(CsvProfilesFileSchema), 'data/csv-profiles.json'],
  ['transaction', TransactionSchema, 'one line of data/transactions/<account>/<year>.jsonl'],
  ['balance', BalanceSnapshotSchema, 'one line of data/balances/<account>.jsonl'],
  ['holdings', HoldingsSnapshotSchema, 'one line of data/holdings/<account>.jsonl'],
  ['figure', FigureSchema, 'one line of data/figures.jsonl'],
  ['import', ImportRecordSchema, 'data/imports/<year>/<id>.json'],
  ['proposal', ProposalSchema, 'data/proposals/<year>/<id>.json (a proposed fix you applied or dismissed)'],
  ['instruments', withSchemaKey(InstrumentsFileSchema), 'data/instruments.json'],
  ['assumption', AssumptionSchema, 'one line of data/assumptions.jsonl'],
  ['research', ResearchSchema, 'one line of data/research.jsonl'],
  ['insight', InsightSchema, 'one line of data/insights.jsonl'],
  ['context', ContextSchema, 'one line of data/context.jsonl'],
  ['note', NoteSchema, 'one line of data/notes.jsonl'],
  ['receipt', ReceiptSchema, 'one line of data/receipts.jsonl'],
  ['employments', withSchemaKey(EmploymentsFileSchema), 'data/employments.json (your jobs)'],
  ['companies', withSchemaKey(CompaniesFileSchema), 'data/companies.json (companies you hold shares in)'],
  ['agreements', withSchemaKey(AgreementsFileSchema), 'data/agreements.json (agreements to pay: their schedules and what their documents say)'],
  ['coverage', withSchemaKey(CoverageFileSchema), 'data/coverage.json (stretches you confirmed nothing is missing from)'],
  ['hmrc', HmrcRecordSchema, "one line of data/hmrc.jsonl (HMRC's records about you)"],
  ['payslips', PayslipRecordSchema, 'one line of data/payslips.jsonl (a payslip in full)'],
  ['terms', TermsSchema, "one line of data/terms.jsonl (an account's terms as one document gives them)"],
];
await mkdir(out, { recursive: true });
for (const [name, schema, describes] of schemas) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const doc = { $id: `${name}.schema.json`, title: name, description: `Schema for ${describes}. Generated from src/shared/schema.ts by \`npm run schemas\`; do not edit.`, ...json };
  await writeFile(path.join(out, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`schemas/${name}.schema.json`);
}
