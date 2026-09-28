// Set (or change) the login for the web app. Writes FINANCE_USERNAME, FINANCE_PASSWORD_HASH and,
// if missing, FINANCE_SESSION_SECRET into .env (mode 0600). Changing the password signs out every
// existing session.
//
//   npm run set-password                      (prompts)
//   FINANCE_NEW_PASSWORD=… npm run set-password -- --user james   (non-interactive)

import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { hashPassword } from '../src/server/auth';
import { PROJECT_ROOT } from '../src/server/config';

const envFile = path.join(PROJECT_ROOT, '.env');
const argv = process.argv.slice(2);
const userArg = argv.includes('--user') ? argv[argv.indexOf('--user') + 1] : undefined;

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else if (s === '\r\n' || s === '\n') out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  let username = userArg ?? '';
  let password = process.env.FINANCE_NEW_PASSWORD ?? '';
  if (!username) username = (await ask(`Username [${os.userInfo().username}]: `)).trim() || os.userInfo().username;
  if (!password) {
    password = await ask('New password: ', true);
    const again = await ask('Repeat password: ', true);
    if (password !== again) throw new Error('Passwords do not match.');
  }
  if (password.length < 12) throw new Error('Use at least 12 characters (a passphrase is best).');
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw new Error('Username may contain letters, digits and . _ @ - only.');

  let env = '';
  try {
    env = await readFile(envFile, 'utf8');
  } catch {
    env = '';
  }
  const set = (key: string, value: string) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, line) : `${env}${env && !env.endsWith('\n') ? '\n' : ''}${line}\n`;
  };
  set('FINANCE_USERNAME', username);
  set('FINANCE_PASSWORD_HASH', await hashPassword(password));
  if (!/^FINANCE_SESSION_SECRET=.{32,}$/m.test(env)) set('FINANCE_SESSION_SECRET', randomBytes(32).toString('base64url'));
  await writeFile(envFile, env, { mode: 0o600 });
  await chmod(envFile, 0o600);
  console.log(`Login set for "${username}" in ${envFile}. Restart the server for it to take effect.`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
