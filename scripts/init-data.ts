// Make a private data repository for your financial data, apart from the code
// (docs/SELF_HOSTING.md, "The layout").
//
//   npm run init-data -- ~/dev/finance-data
//
// It prints the lines that point the app at it. `npm run deploy -- --setup` writes them into the
// live service's .env for you (with FINANCE_DATA_REPO set to the same directory).

import os from 'node:os';
import { PROJECT_ROOT } from '../src/server/config';
import { initDataRepository } from '../src/server/datarepo';

const arg = process.argv[2];
if (!arg || arg.startsWith('-')) {
  console.error('Give the directory to make: npm run init-data -- <dir>');
  process.exit(2);
}
try {
  const made = await initDataRepository(arg.replace(/^~(?=\/|$)/, os.homedir()), PROJECT_ROOT);
  console.log(`Made a data repository at ${made.dir} (no remote; pushes are refused).`);
  console.log('\nFor the live service, add these to its .env (npm run deploy -- --setup does it, with');
  console.log(`FINANCE_DATA_REPO=${made.dir}):\n`);
  for (const line of made.env) console.log(`  ${line}`);
  console.log('\nTo use it from this checkout instead (npm run dev), FINANCE_DATA_DIR is enough; it needs a login.');
} catch (err) {
  console.error(`init-data: ${(err as Error).message}`);
  process.exit(1);
}
