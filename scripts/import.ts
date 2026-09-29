// Queue files for import from the terminal: they are copied into the inbox folder, which the running
// app watches. (If the app is not running they are picked up when it next starts.)
//
//   npm run import -- ~/Downloads/statement.pdf ~/Pictures/Screenshot*.png

import { copyFile, mkdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, loadDotEnv } from '../src/server/config';
import { ACCEPTED_EXTENSIONS } from '../src/server/ingest/detect';

loadDotEnv();
const config = loadConfig();
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('Usage: npm run import -- <file> [more files…]');
  process.exit(1);
}
await mkdir(config.inboxDir, { recursive: true });
let queued = 0;
for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    console.error(`skip ${f}: unsupported type`);
    continue;
  }
  try {
    const s = await stat(f);
    if (!s.isFile()) throw new Error('not a file');
    const dest = path.join(config.inboxDir, path.basename(f));
    await copyFile(f, dest);
    // Keep the file's own modified time: it is the capture date of last resort for a screenshot.
    await utimes(dest, s.atime, s.mtime);
    queued++;
    console.log(`queued ${path.basename(f)}`);
  } catch (err) {
    console.error(`skip ${f}: ${(err as Error).message}`);
  }
}
console.log(`${queued} file(s) copied to ${config.inboxDir}. Review them on the Import page.`);
