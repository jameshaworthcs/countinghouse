// Flat ESLint config: type-aware rules for app code, React hooks rules for the web app.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Store accessors that reach a company's data (src/server/store.ts, "Scope"). */
const COMPANY_SCOPE = ['allAccounts', 'allTransactions', 'allBalances', 'allHoldings', 'allFigures', 'allCoverageConfirmations', 'allInstitutions', 'companyAccounts', 'companyTransactions', 'companyJournals', 'bookRules'];
/** The canary of tests/company-scope.test.ts: never outside tests/. */
const TEST_ONLY = 'widenScopeForTest';
const restricted = (property) => ({
  property,
  message: property === TEST_ONLY ? 'For tests only.' : 'Reaches company data: personal code uses the store\'s own accessors. Infrastructure that must see every account is listed in SCOPE_ALLOWLIST (eslint.config.js), with its reason.',
});
/** The files that may see every account (or one company's), and why. */
const SCOPE_ALLOWLIST = {
  // The store itself.
  'src/server/store.ts': 'defines the accessors',
  // Enrichment: places for every row; your rows and each company's worked out apart; transfers paired
  // within one side, and links across the line taken away.
  'src/server/enrich.ts': 'works out every row, each side apart',
  // Building an import's draft: which account a document is of is for it to say (a company's too),
  // by account details and the rows already recorded; new account ids unique among all.
  'src/server/ingest/draft.ts': 'matches a document to any account',
  // A company's own accounts on their own: their balance engine, their group on the Accounts page.
  'src/server/analytics/company-accounts.ts': 'company accounts, each company alone',
  // A company's books: its general ledger from its own rows, the rows of yours paid for or lent to it,
  // its journals and book rules, one company at a time. Your director's loan reads its postings to the
  // loan once the company keeps books here (director-loan.ts): the one way company data reaches you.
  'src/server/analytics/ledger.ts': "a company's books, one company at a time",
  // A company's accounts for a period (its trial balance, profit and loss, balance sheet, register,
  // bank reconciliation), from its ledger, one company at a time, served only from its own routes.
  'src/server/analytics/period-accounts.ts': "a company's period accounts, one company at a time",
  // A company's VAT returns (their boxes, the returns filed against them, errors, penalty points and
  // the thresholds), from its ledger and its opening journals, one company at a time, served only from
  // its own routes.
  'src/server/analytics/vat-return.ts': "a company's VAT returns, one company at a time",
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**', 'demo-data/**', 'demo-sparse/**', 'schemas/**', '.work/**', 'screens/**', 'eval/.out/**', 'eval/results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts', 'tests/**/*.ts', 'eval/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/server/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'eval/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/web/public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
  // Company accounts (docs/ARCHITECTURE.md, "Company accounts"): the store's accessors give your own
  // data only, and the ones that reach a company's data are allowed only in the files below, so a
  // personal page or figure cannot widen its scope by accident. A new file that needs one is a
  // deliberate change to this list, with its reason.
  {
    files: ['src/server/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-restricted-properties': ['error', ...COMPANY_SCOPE.map(restricted), restricted(TEST_ONLY)] },
  },
  {
    files: Object.keys(SCOPE_ALLOWLIST),
    rules: { 'no-restricted-properties': ['error', restricted(TEST_ONLY)] },
  },
);
