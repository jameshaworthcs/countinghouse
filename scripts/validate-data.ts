// Validate the data directory against the format (the same checks the app runs on start-up).
//
//   npm run validate            (data/)
//   FINANCE_DATA_DIR=demo-data npm run validate

import { loadConfig, loadDotEnv } from '../src/server/config';
import { BalanceEngine } from '../src/server/analytics/balances';
import { Store } from '../src/server/store';

loadDotEnv();
const config = loadConfig();
const store = await Store.open(config.dataDir);
const engine = new BalanceEngine(store);
const gaps = store.accounts.flatMap((a) => engine.gaps(a.id).map((g) => ({ account: a.id, ...g })));
console.log(`${config.dataDir}: format v${store.meta.version}, ${store.accounts.length} accounts, ${store.transactionCount()} transactions, ${store.balances().length} balances, ${store.figures.length} figures, ${store.imports.length} imports`);
for (const i of store.issues) console.log(`${i.severity === 'error' ? '✗' : '!'} ${i.file}: ${i.message}`);
for (const g of gaps) console.log(`! ${g.account}: balance gap ${g.from} → ${g.to} (${g.difference.toFixed(2)})`);
const errors = store.issues.filter((i) => i.severity === 'error').length;
console.log(errors ? `${errors} error(s)` : 'valid');
process.exit(errors ? 1 : 0);
