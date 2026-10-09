// The demo in a GitHub codespace (FINANCE_DEMO_CODESPACE=1, set only by .devcontainer/).
//
// Codespaces forwards the port through GitHub's proxy, which reaches the app on loopback with
// X-Forwarded-For/-Proto/-Host set, so the app treats it as proxied and wants a login. The setting
// makes a throwaway login for the session, shown on the sign-in form, and lets the CSRF check accept
// the Origin the proxy writes (security.ts, csrfGuard). It is refused over anything but untracked
// demo data with no login of its own, so neither can ever apply to real data.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface DemoLogin {
  username: string;
  password: string;
}

export function codespaceRequested(env: NodeJS.ProcessEnv): boolean {
  return env.FINANCE_DEMO_CODESPACE === '1';
}

/** Why the codespace setting may not apply here, or null when it may. */
export function codespaceRefusal(opts: { dataDir: string; exists: boolean; tracked: boolean; env: NodeJS.ProcessEnv }): string | null {
  const { env } = opts;
  // A directory not made yet can't be told apart from real data: git would only see it once it exists.
  if (!opts.exists) return `FINANCE_DEMO_CODESPACE needs the demo data generated first (npm run demo), and ${opts.dataDir} has none.`;
  if (opts.tracked) return `FINANCE_DEMO_CODESPACE is for the demo data only, and ${opts.dataDir} is tracked in git.`;
  if (!/demo/.test(path.basename(opts.dataDir))) return `FINANCE_DEMO_CODESPACE is for the demo data only, and ${opts.dataDir} is not a demo directory.`;
  if (env.FINANCE_USERNAME || env.FINANCE_PASSWORD_HASH || env.FINANCE_OIDC_CLIENT_ID) return 'FINANCE_DEMO_CODESPACE makes its own throwaway login: unset FINANCE_USERNAME, FINANCE_PASSWORD_HASH and FINANCE_OIDC_CLIENT_ID.';
  return null;
}

/** A new login for this run of the server: it lives in memory only, and changes at each start. */
export function newDemoLogin(): DemoLogin {
  return { username: 'demo', password: randomBytes(9).toString('base64url') };
}
