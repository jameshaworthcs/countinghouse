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
  MetaSchema,
  NoteSchema,
  ProfileSchema,
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
  ['instruments', withSchemaKey(InstrumentsFileSchema), 'data/instruments.json'],
  ['assumption', AssumptionSchema, 'one line of data/assumptions.jsonl'],
  ['research', ResearchSchema, 'one line of data/research.jsonl'],
  ['insight', InsightSchema, 'one line of data/insights.jsonl'],
  ['context', ContextSchema, 'one line of data/context.jsonl'],
  ['note', NoteSchema, 'one line of data/notes.jsonl'],
];
await mkdir(out, { recursive: true });
for (const [name, schema, describes] of schemas) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const doc = { $id: `${name}.schema.json`, title: name, description: `Schema for ${describes}. Generated from src/shared/schema.ts by \`npm run schemas\`; do not edit.`, ...json };
  await writeFile(path.join(out, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`schemas/${name}.schema.json`);
}
